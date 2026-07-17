import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverGitChanges, GitScopeError } from '../../src/scope/git.js';
import {
  captureGitStatus,
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
  removeTempProject,
  runGitFixtureCommand,
  writeProjectFile,
} from '../helpers/temp-project.js';

const temporaryRoots: string[] = [];

async function createRepository(
  files?: Readonly<Record<string, string>>,
): Promise<{ root: string; initialCommit: string }> {
  const root = await createTempProject('codebase-doctor-git-');
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  const initialCommit = await commitInitialContent(root, files);
  return { root, initialCommit };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTempProject));
});

describe('discoverGitChanges', () => {
  it('discovers staged and unstaged modifications relative to HEAD', async () => {
    const { root, initialCommit } = await createRepository({
      'staged.txt': 'initial\n',
      'unstaged.txt': 'initial\n',
    });
    await writeProjectFile(root, 'staged.txt', 'staged change\n');
    await runGitFixtureCommand(root, ['add', '--', 'staged.txt']);
    await writeProjectFile(root, 'unstaged.txt', 'unstaged change\n');

    await expect(discoverGitChanges({ root })).resolves.toEqual({
      base: { kind: 'head', requestedRef: null, resolvedCommit: initialCommit },
      changes: [
        { status: 'modified', path: 'staged.txt' },
        { status: 'modified', path: 'unstaged.txt' },
      ],
    });
  });

  it('discovers untracked files and tracked deletions', async () => {
    const { root } = await createRepository({ 'removed.txt': 'remove me\n' });
    await rm(join(root, 'removed.txt'));
    await writeProjectFile(root, 'new directory/new file.txt', 'new\n');

    const result = await discoverGitChanges({ root });

    expect(result.changes).toEqual([
      { status: 'untracked', path: 'new directory/new file.txt' },
      { status: 'deleted', path: 'removed.txt' },
    ]);
  });

  it('discovers renames with source and destination paths', async () => {
    const { root } = await createRepository({ 'before.txt': 'same content\n' });
    await runGitFixtureCommand(root, ['mv', '--', 'before.txt', 'after.txt']);

    const result = await discoverGitChanges({ root });

    expect(result.changes).toEqual([
      { status: 'renamed', path: 'after.txt', previousPath: 'before.txt' },
    ]);
  });

  it('uses the merge base of an explicit branch ref and includes committed changes', async () => {
    const { root, initialCommit } = await createRepository();
    await runGitFixtureCommand(root, ['branch', 'audit-base']);
    await writeProjectFile(root, 'committed.txt', 'branch content\n');
    await runGitFixtureCommand(root, ['add', '--', 'committed.txt']);
    await runGitFixtureCommand(root, ['commit', '--quiet', '--message', 'branch change']);

    await expect(discoverGitChanges({ root, baseRef: 'audit-base' })).resolves.toEqual({
      base: {
        kind: 'merge-base',
        requestedRef: 'audit-base',
        resolvedCommit: initialCommit,
      },
      changes: [{ status: 'added', path: 'committed.txt' }],
    });
  });

  it('rejects invalid refs with a concise redacted operational error', async () => {
    const { root } = await createRepository();
    const invalidRef = 'https://user:credential@example.invalid/missing';

    const failure = await discoverGitChanges({ root, baseRef: invalidRef })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitScopeError);
    expect(failure).toMatchObject({ code: 'GIT_INVALID_BASE_REF' });
    expect(String(failure)).not.toContain(invalidRef);
    expect(String(failure)).not.toContain('credential');
  });

  it('rejects non-Git roots', async () => {
    const root = await createTempProject('codebase-doctor-not-git-');
    temporaryRoots.push(root);

    await expect(discoverGitChanges({ root })).rejects.toMatchObject({
      code: 'GIT_NOT_REPOSITORY',
    });
  });

  it('rejects a nested directory whose canonical root differs from the repository root', async () => {
    const { root } = await createRepository();
    const nested = join(root, 'nested');
    await mkdir(nested);

    await expect(discoverGitChanges({ root: nested })).rejects.toMatchObject({
      code: 'GIT_ROOT_MISMATCH',
    });
  });

  it('does not mutate index, refs, config, or worktree while discovering changes', async () => {
    const { root } = await createRepository({ 'tracked.txt': 'initial\n' });
    await writeProjectFile(root, 'tracked.txt', 'changed\n');
    await writeProjectFile(root, 'untracked.txt', 'new\n');
    const before = await captureGitStatus(root);

    await discoverGitChanges({ root });

    expect(await captureGitStatus(root)).toBe(before);
  });
});
