import { posix } from 'node:path';
import type { ChangedPath, ChangeStatus } from './types.js';

const STATUS_BY_CODE: Readonly<Record<'A' | 'D' | 'M', ChangeStatus>> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
};

const STATUS_PRIORITY: Readonly<Record<ChangeStatus, number>> = {
  modified: 1,
  untracked: 2,
  added: 3,
  copied: 4,
  renamed: 5,
  deleted: 6,
};

const VALID_STATUSES = new Set<ChangeStatus>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
]);

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareChanges(left: ChangedPath, right: ChangedPath): number {
  return compareText(left.path, right.path)
    || compareText(left.previousPath ?? '', right.previousPath ?? '')
    || compareText(left.status, right.status);
}

function normalizeRepositoryPath(value: string): string {
  if (value.length === 0 || value.includes('\0')) {
    throw new Error('Git path must not be empty or contain NUL bytes.');
  }

  const withPosixSeparators = value.replaceAll('\\', '/');
  if (
    withPosixSeparators.startsWith('/')
    || /^[A-Za-z]:\//u.test(withPosixSeparators)
  ) {
    throw new Error(`Git path must be repository-relative: ${JSON.stringify(value)}`);
  }

  const normalized = posix.normalize(withPosixSeparators);
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`Git path escapes the repository: ${JSON.stringify(value)}`);
  }

  return normalized;
}

function tokenizeNulOutput(output: string): string[] {
  if (output.length === 0) {
    return [];
  }
  if (!output.endsWith('\0')) {
    throw new Error('Git output must be NUL-terminated.');
  }

  const tokens = output.split('\0');
  tokens.pop();
  return tokens;
}

function parseScoredStatus(status: string): 'renamed' | 'copied' | null {
  const match = /^([RC])(\d{1,3})$/u.exec(status);
  if (match === null) {
    return null;
  }

  const score = Number(match[2]);
  if (score > 100) {
    throw new Error(`Invalid Git change status: ${status}`);
  }
  return match[1] === 'R' ? 'renamed' : 'copied';
}

export function parseNameStatus(output: string): ChangedPath[] {
  const tokens = tokenizeNulOutput(output);
  const changes: ChangedPath[] = [];

  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index];
    if (statusToken === undefined || statusToken.length === 0) {
      throw new Error('Git change status must not be empty.');
    }
    index += 1;

    if (statusToken === 'A' || statusToken === 'D' || statusToken === 'M') {
      const path = tokens[index];
      if (path === undefined) {
        throw new Error(`Git ${statusToken} record is missing its path.`);
      }
      index += 1;
      changes.push({
        status: STATUS_BY_CODE[statusToken],
        path: normalizeRepositoryPath(path),
      });
      continue;
    }

    const scoredStatus = parseScoredStatus(statusToken);
    if (scoredStatus === null) {
      throw new Error(`Unknown Git change status: ${statusToken}`);
    }

    const previousPath = tokens[index];
    const path = tokens[index + 1];
    if (previousPath === undefined || path === undefined) {
      throw new Error(`Git ${statusToken} record requires source and destination paths.`);
    }
    index += 2;
    changes.push({
      status: scoredStatus,
      path: normalizeRepositoryPath(path),
      previousPath: normalizeRepositoryPath(previousPath),
    });
  }

  return changes.sort(compareChanges);
}

export function parseUntracked(output: string): ChangedPath[] {
  return tokenizeNulOutput(output)
    .map((path): ChangedPath => ({
      status: 'untracked',
      path: normalizeRepositoryPath(path),
    }))
    .sort(compareChanges);
}

function normalizeChange(change: ChangedPath): ChangedPath {
  if (!VALID_STATUSES.has(change.status)) {
    throw new Error(`Unknown Git change status: ${String(change.status)}`);
  }

  const path = normalizeRepositoryPath(change.path);
  if (change.status === 'renamed' || change.status === 'copied') {
    if (change.previousPath === undefined) {
      throw new Error(`${change.status} changes require a previous path.`);
    }
    return {
      status: change.status,
      path,
      previousPath: normalizeRepositoryPath(change.previousPath),
    };
  }

  return { status: change.status, path };
}

function chooseChange(left: ChangedPath, right: ChangedPath): ChangedPath {
  const priorityDifference = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
  if (priorityDifference !== 0) {
    return priorityDifference > 0 ? left : right;
  }
  return compareChanges(left, right) <= 0 ? left : right;
}

export function mergeChangedPaths(
  ...views: readonly (readonly ChangedPath[])[]
): ChangedPath[] {
  const merged = new Map<string, ChangedPath>();

  for (const view of views) {
    for (const rawChange of view) {
      const change = normalizeChange(rawChange);
      const current = merged.get(change.path);
      merged.set(change.path, current === undefined
        ? change
        : chooseChange(current, change));
    }
  }

  return [...merged.values()].sort(compareChanges);
}
