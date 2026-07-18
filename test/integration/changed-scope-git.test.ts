import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverGitChanges, GitScopeError } from '../../src/scope/git.js';
import {
  captureGitRepositorySnapshot,
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
  removeTempProject,
  runGitFixtureCommand,
  writeProjectFile,
} from '../helpers/temp-project.js';

const temporaryRoots: string[] = [];
const repositoryRoot = process.cwd();

function isolatedGitEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: '',
    SUPABASE_DB_URL: '',
  };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GIT_CONFIG_')) delete environment[name];
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = join(root, '.codebase-doctor-empty-global-config');
  return environment;
}

function auditCli(root: string, format: 'json' | 'text' | 'sarif') {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve(repositoryRoot, 'src', 'cli.ts'),
      'audit',
      root,
      '--changed',
      '--format',
      format,
      '--fail-on',
      'none',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 15_000,
      env: isolatedGitEnvironment(root),
    },
  );
}

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

  it('keeps slash and literal-backslash filenames distinct end-to-end', async () => {
    const { root } = await createRepository({
      'a/b': 'slash path\n',
      'a\\b': 'backslash path\n',
    });
    await writeProjectFile(root, 'a/b', 'changed slash path\n');
    await writeProjectFile(root, 'a\\b', 'changed backslash path\n');

    const result = await discoverGitChanges({ root });

    expect(result.changes).toEqual([
      { status: 'modified', path: 'a/b' },
      { status: 'modified', path: 'a\\b' },
    ]);
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

  it.each(['--fork-point', '--octopus', '--independent'])(
    'treats the option-like base ref %s only as a ref name',
    async (baseRef) => {
      const { root } = await createRepository();

      await expect(discoverGitChanges({ root, baseRef })).rejects.toMatchObject({
        code: 'GIT_INVALID_BASE_REF',
      });
    },
  );

  it('reports a file-to-symlink type change as modified', async () => {
    const { root } = await createRepository({
      'target.txt': 'target\n',
      'typed-path': 'regular file\n',
    });
    await rm(join(root, 'typed-path'));
    await symlink('target.txt', join(root, 'typed-path'));

    const result = await discoverGitChanges({ root });

    expect(result.changes).toEqual([
      { status: 'modified', path: 'typed-path' },
    ]);
  });

  it.each([
    ['space', ' '],
    ['carriage return', '\r'],
  ])('preserves a trailing %s in the canonical repository root', async (_name, suffix) => {
    const parent = await createTempProject('codebase-doctor-space-root-');
    temporaryRoots.push(parent);
    const root = join(parent, `repository${suffix}`);
    await mkdir(root);
    await initializeGitRepository(root);
    const initialCommit = await commitInitialContent(root);

    await expect(discoverGitChanges({ root })).resolves.toMatchObject({
      base: { resolvedCommit: initialCommit },
      changes: [],
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

  it('does not mutate status, HEAD, or local config while discovering changes', async () => {
    const { root } = await createRepository({ 'tracked.txt': 'initial\n' });
    await writeProjectFile(root, 'tracked.txt', 'changed\n');
    await writeProjectFile(root, 'untracked.txt', 'new\n');
    const before = await captureGitRepositorySnapshot(root);

    await discoverGitChanges({ root });

    expect(await captureGitRepositorySnapshot(root)).toEqual(before);
  });

  it('disables repository hooks and commit signing for disposable fixture commits', async () => {
    const root = await createTempProject('codebase-doctor-hook-isolation-');
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await runGitFixtureCommand(root, ['config', '--local', 'commit.gpgSign', 'true']);
    await writeProjectFile(root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    await chmod(join(root, '.git/hooks/pre-commit'), 0o755);

    await expect(commitInitialContent(root)).resolves.toMatch(/^[0-9a-f]{40}$/u);
  });
});

describe('changed source-integrity audit', () => {
  it.each([
    ['deleted', async (root: string) => {
      await rm(join(root, 'src/target.ts'));
    }],
    ['renamed', async (root: string) => {
      await runGitFixtureCommand(root, [
        'mv', '--', 'src/target.ts', 'src/renamed-target.ts',
      ]);
    }],
  ] as const)(
    'selects an unchanged importer when its explicit target is %s without reporting an unrelated old miss',
    async (changeKind, applyChange) => {
      const { root } = await createRepository({
        'package.json': JSON.stringify({
          name: 'changed-source-integrity',
          private: true,
        }, null, 2),
        'src/importer.ts': [
          'import { value } from "./target.ts";',
          'export const imported = value;',
          '',
        ].join('\n'),
        'src/target.ts': 'export const value = 1;\n',
        'src/unrelated.ts': 'import "./unrelated-old-missing.ts";\n',
      });
      await applyChange(root);
      const protectedContents = new Map([
        ['src/importer.ts', readFileSync(join(root, 'src/importer.ts'))],
        ['src/unrelated.ts', readFileSync(join(root, 'src/unrelated.ts'))],
      ]);
      if (changeKind === 'renamed') {
        protectedContents.set(
          'src/renamed-target.ts',
          readFileSync(join(root, 'src/renamed-target.ts')),
        );
      }
      const before = await captureGitRepositorySnapshot(root);

      const json = auditCli(root, 'json');
      const text = auditCli(root, 'text');
      const sarif = auditCli(root, 'sarif');
      const report = JSON.parse(json.stdout);
      const sarifReport = JSON.parse(sarif.stdout);
      const findings = report.findings.filter(
        ({ doctorId }: { doctorId: string }) => doctorId === 'repository/source-integrity',
      );

      expect(json.status, json.stderr).toBe(0);
      expect(text.status, text.stderr).toBe(0);
      expect(sarif.status, sarif.stderr).toBe(0);
      expect(report.auditScope.changes).toContainEqual(expect.objectContaining({
        status: changeKind,
        path: changeKind === 'renamed' ? 'src/renamed-target.ts' : 'src/target.ts',
      }));
      expect(findings).toEqual([
        expect.objectContaining({
          ruleId: 'source/import-target-missing',
          location: expect.objectContaining({ path: 'src/importer.ts' }),
          evidence: [expect.objectContaining({
            detail: expect.stringContaining('src/target.ts'),
          })],
        }),
      ]);
      expect(report.coverage).toContainEqual(expect.objectContaining({
        moduleId: 'repository/source-integrity',
        scope: 'changed',
        statementsRecognized: 1,
      }));
      expect(text.stdout.match(/Internal import target is missing/g)).toHaveLength(1);
      expect(sarifReport.runs[0].results.filter(
        ({ ruleId }: { ruleId: string }) => ruleId === 'source/import-target-missing',
      )).toHaveLength(1);
      expect(await captureGitRepositorySnapshot(root)).toEqual(before);
      for (const [path, contents] of protectedContents) {
        expect(readFileSync(join(root, path)), path).toEqual(contents);
      }
    },
  );
});
