import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  discoverGitChanges,
  GitScopeError,
  mergeChangedPaths,
  parseNameStatus,
  parseUntracked,
} from '../../../src/scope/git.js';
import type { ChangedPath } from '../../../src/scope/types.js';

it('returns mutable arrays from the public Git parsing contract', () => {
  expectTypeOf(parseNameStatus('')).toEqualTypeOf<ChangedPath[]>();
  expectTypeOf(parseUntracked('')).toEqualTypeOf<ChangedPath[]>();
  expectTypeOf(mergeChangedPaths()).toEqualTypeOf<ChangedPath[]>();
});

describe('parseNameStatus', () => {
  it('parses every supported status and sorts normalized paths deterministically', () => {
    const output = [
      'M', 'zeta/file.ts',
      'T', 'changed-type.ts',
      'A', 'source file.ts',
      'D', 'removed.ts',
      'R087', 'old\\location.ts', 'renamed/location.ts',
      'C100', 'source.ts', 'copied\\location.ts',
    ].join('\0') + '\0';

    expect(parseNameStatus(output)).toEqual([
      { status: 'modified', path: 'changed-type.ts' },
      {
        status: 'copied',
        path: 'copied\\location.ts',
        previousPath: 'source.ts',
      },
      {
        status: 'deleted',
        path: 'removed.ts',
      },
      {
        status: 'renamed',
        path: 'renamed/location.ts',
        previousPath: 'old\\location.ts',
      },
      { status: 'added', path: 'source file.ts' },
      { status: 'modified', path: 'zeta/file.ts' },
    ]);
  });

  it('uses previousPath and status as deterministic sorting tie-breakers', () => {
    const output = [
      'R100', 'z-old.ts', 'same.ts',
      'C100', 'source.ts', 'same.ts',
      'R100', 'a-old.ts', 'same.ts',
    ].join('\0') + '\0';

    expect(parseNameStatus(output)).toEqual([
      { status: 'renamed', path: 'same.ts', previousPath: 'a-old.ts' },
      { status: 'copied', path: 'same.ts', previousPath: 'source.ts' },
      { status: 'renamed', path: 'same.ts', previousPath: 'z-old.ts' },
    ]);
  });

  it.each([
    ['missing path', 'M\0'],
    ['missing record terminator', 'M\0file.ts'],
    ['missing rename destination', 'R100\0old.ts\0'],
    ['missing copy source', 'C100\0'],
    ['rename without a score', 'R\0old.ts\0new.ts\0'],
    ['invalid rename score', 'R101\0old.ts\0new.ts\0'],
    ['empty status', '\0file.ts\0'],
  ])('rejects malformed %s records', (_description, output) => {
    expect(() => parseNameStatus(output)).toThrow();
  });

  it.each(['X\0file.ts\0', 'U\0file.ts\0'])(
    'rejects the unknown status in %s',
    (output) => {
      expect(() => parseNameStatus(output)).toThrow(/status/i);
    },
  );

  it.each([
    'M\0/absolute.ts\0',
    'A\0C:\\absolute.ts\0',
    'M\0C:outside.ts\0',
    'A\0C:../outside.ts\0',
    'D\0C:\0',
    'D\0../outside.ts\0',
    'R100\0../old.ts\0new.ts\0',
    'C100\0old.ts\0/absolute.ts\0',
  ])('rejects unsafe paths in %s', (output) => {
    expect(() => parseNameStatus(output)).toThrow(/path/i);
  });

  it('returns an empty list for empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('parseUntracked', () => {
  it('parses NUL-delimited paths, preserves backslashes, and sorts them', () => {
    expect(parseUntracked('z file.ts\0nested\\file.ts\0a.ts\0')).toEqual([
      { status: 'untracked', path: 'a.ts' },
      { status: 'untracked', path: 'nested\\file.ts' },
      { status: 'untracked', path: 'z file.ts' },
    ]);
  });

  it.each([
    'unterminated.ts',
    '\0',
    '/absolute.ts\0',
    'C:\\absolute.ts\0',
  ])('rejects malformed or unsafe output in %s', (output) => {
    expect(() => parseUntracked(output)).toThrow(/path|NUL/i);
  });

  it('returns an empty list for empty output', () => {
    expect(parseUntracked('')).toEqual([]);
  });
});

describe('mergeChangedPaths', () => {
  const staged: readonly ChangedPath[] = [
    { status: 'modified', path: 'modified-then-deleted.ts' },
    { status: 'renamed', path: 'renamed-then-modified.ts', previousPath: 'old.ts' },
    { status: 'added', path: 'duplicate.ts' },
  ];
  const unstaged: readonly ChangedPath[] = [
    { status: 'deleted', path: 'modified-then-deleted.ts' },
    { status: 'modified', path: 'renamed-then-modified.ts' },
    { status: 'modified', path: 'duplicate.ts' },
  ];
  const untracked: readonly ChangedPath[] = [
    { status: 'untracked', path: 'new file.ts' },
    { status: 'untracked', path: 'duplicate.ts' },
  ];

  it('deduplicates staged, unstaged, and untracked views without weakening changes', () => {
    expect(mergeChangedPaths(staged, unstaged, untracked)).toEqual([
      { status: 'added', path: 'duplicate.ts' },
      { status: 'deleted', path: 'modified-then-deleted.ts' },
      { status: 'untracked', path: 'new file.ts' },
      {
        status: 'renamed',
        path: 'renamed-then-modified.ts',
        previousPath: 'old.ts',
      },
    ]);
  });

  it('is deterministic regardless of view and item order', () => {
    const forward = mergeChangedPaths(staged, unstaged, untracked);
    const reverse = mergeChangedPaths(
      [...untracked].reverse(),
      [...unstaged].reverse(),
      [...staged].reverse(),
    );

    expect(reverse).toEqual(forward);
  });

  it('preserves literal backslashes and validates paths supplied by callers', () => {
    expect(mergeChangedPaths([
      { status: 'modified', path: 'nested\\file.ts' },
    ])).toEqual([
      { status: 'modified', path: 'nested\\file.ts' },
    ]);

    expect(() => mergeChangedPaths([
      { status: 'modified', path: '../outside.ts' },
    ])).toThrow(/path/i);
  });

  it('chooses rename metadata deterministically when duplicate renames disagree', () => {
    expect(mergeChangedPaths(
      [{ status: 'renamed', path: 'current.ts', previousPath: 'z-old.ts' }],
      [{ status: 'renamed', path: 'current.ts', previousPath: 'a-old.ts' }],
    )).toEqual([
      { status: 'renamed', path: 'current.ts', previousPath: 'a-old.ts' },
    ]);
  });

  it('rejects previousPath metadata for statuses that do not use it', () => {
    expect(() => mergeChangedPaths([
      { status: 'modified', path: 'current.ts', previousPath: 'old.ts' },
    ])).toThrow(/previous path/i);
  });
});

describe('discoverGitChanges runner contract', () => {
  it('rejects a blank base ref before invoking Git', async () => {
    const calls: readonly string[][] = [];
    const runner = {
      run: async (_root: string, args: readonly string[]) => {
        (calls as string[][]).push([...args]);
        return '';
      },
    };

    await expect(discoverGitChanges({ root: '.', baseRef: '  ' }, runner))
      .rejects.toMatchObject({ code: 'GIT_INVALID_BASE_REF' });
    expect(calls).toEqual([]);
  });

  it('maps runner failures to a stable error without leaking sensitive output', async () => {
    const secret = 'https://user:token@example.invalid/repository.git';
    const runner = {
      run: async () => {
        throw new Error(`fatal: could not read ${secret}\nENV_SECRET=hunter2`);
      },
    };

    const failure = await discoverGitChanges({ root: '.', baseRef: 'missing' }, runner)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitScopeError);
    expect(failure).toMatchObject({ code: 'GIT_NOT_REPOSITORY' });
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain('hunter2');
  });
});
