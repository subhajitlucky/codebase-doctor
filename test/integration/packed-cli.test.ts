import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNpmPackJson } from "../../scripts/npm-pack-json.mjs";

const repositoryRoot = process.cwd();
const SECRET_ALPHABET = "R7t9Y2u8I4o6P1a3S5d0FgHjKlZxCvBn";

function generatedToken(prefix: string, length = 32): string {
  let value = prefix;
  for (let index = 0; value.length < prefix.length + length; index += 1) {
    value += SECRET_ALPHABET[index % SECRET_ALPHABET.length];
  }
  return value;
}

function run(executable: string, args: readonly string[], cwd = repositoryRoot) {
  return spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("release package", () => {
  it("passes the dry-run package contents contract", () => {
    const result = run(process.execPath, ["scripts/check-package.mjs"]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("installs the real tarball and runs its binary from a clean project", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "codebase-doctor-package-"));
    try {
      const packed = run("npm", [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryRoot,
      ]);
      expect(packed.status, packed.stderr).toBe(0);
      const reports = parseNpmPackJson(packed.stdout);
      expect(reports).toHaveLength(1);
      const [packReport] = reports;
      if (!packReport) {
        throw new Error("Expected npm pack to return one package report.");
      }
      const tarball = join(temporaryRoot, packReport.filename);

      const installed = run("npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ], temporaryRoot);
      expect(installed.status, installed.stderr).toBe(0);

      const binary = resolve(
        temporaryRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "codebase-doctor.cmd" : "codebase-doctor",
      );
      const installedPackage = join(temporaryRoot, "node_modules", "codebase-doctor");
      const [packedReadme, packedArchitecture, packedSkill] = await Promise.all([
        readFile(join(installedPackage, "README.md"), "utf8"),
        readFile(join(installedPackage, "docs", "architecture.md"), "utf8"),
        readFile(join(installedPackage, ".agents", "skills", "codebase-doctor", "SKILL.md"), "utf8"),
      ]);
      expect(packedReadme).toContain("audit . --changed --base main --json");
      expect(packedArchitecture).toMatch(/fixed read-only Git discovery/i);
      expect(packedSkill).toMatch(/Prefer a changed\s+audit after edits/i);
      expect(packedSkill).not.toMatch(/\bnpx\s+codebase-doctor\b/i);
      expect(packedSkill).toMatch(/package acquisition.*pinned.*user-authorized/is);

      const runtimeConsumerPath = join(temporaryRoot, "consumer.mjs");
      await writeFile(runtimeConsumerPath, [
        'import { AUDIT_DOMAINS, GitScopeError, fullAuditScope, planChangedScope } from "codebase-doctor";',
        'const project = { id: "node:app", root: ".", ecosystems: ["node"],',
        '  languages: ["typescript"], frameworks: [], manifestPaths: ["package.json"],',
        '  executionSupport: "supported" };',
        'const base = { kind: "head", requestedRef: null, resolvedCommit: "abc123" };',
        'const changed = planChangedScope(base, [], [project]);',
        'const error = new GitScopeError("GIT_INVALID_BASE_REF", "invalid");',
        'console.log(JSON.stringify({ full: fullAuditScope().mode, changed: changed.mode, code: error.code, domains: AUDIT_DOMAINS.length }));',
      ].join("\n"));
      const runtimeConsumer = run(process.execPath, [runtimeConsumerPath], temporaryRoot);
      expect(runtimeConsumer.status, runtimeConsumer.stderr).toBe(0);
      expect(JSON.parse(runtimeConsumer.stdout)).toEqual({
        full: "full",
        changed: "changed",
        code: "GIT_INVALID_BASE_REF",
        domains: 9,
      });

      const typeConsumerPath = join(temporaryRoot, "consumer.ts");
      await writeFile(typeConsumerPath, `
import {
  AUDIT_DOMAINS,
  type AuditBase,
  type AuditDomain,
  type AuditScope,
  type BaselineComparisonOptions,
  type ChangedPath,
  type DetectedProject,
  type DomainApplicability,
  type DomainCoverage,
  type DomainCoverageEvidence,
  type DomainCoverageStatus,
  type DomainModuleCoverage,
  type DiscoverChangesOptions,
  type DiscoveredChanges,
  type Finding,
  GitScopeError,
  type GitScopeErrorCode,
  discoverGitChanges,
  fullAuditScope,
  planChangedScope,
} from "codebase-doctor";

const project: DetectedProject = {
  id: "node:app", root: ".", ecosystems: ["node"], languages: ["typescript"],
  frameworks: [], manifestPaths: ["package.json"], executionSupport: "supported",
};
const base: AuditBase = { kind: "head", requestedRef: null, resolvedCommit: "abc123" };
const changes: readonly ChangedPath[] = [{ status: "modified", path: "src/index.ts" }];
const scope: AuditScope = planChangedScope(base, changes, [project]);
const full: AuditScope = fullAuditScope();
const code: GitScopeErrorCode = "GIT_INVALID_BASE_REF";
const error: GitScopeError = new GitScopeError(code, "invalid");
const comparison: BaselineComparisonOptions = { includeResolved: false };
const finding: Finding = {
  ruleId: "example/rule", doctorId: "example", severity: "low", confidence: "high",
  category: "example", title: "Example", message: "Example", evidence: [],
  impact: "Machine-readable impact.", remediationConstraints: ["Preserve behavior."],
  verification: { command: "codebase-doctor audit . --json", expected: "Fingerprint absent with completed coverage." },
  fingerprint: "fingerprint",
};
const discovery: (options: DiscoverChangesOptions) => Promise<DiscoveredChanges> = discoverGitChanges;
const domain: AuditDomain = "security";
const applicability: DomainApplicability = "unknown";
const domainStatus: DomainCoverageStatus = "unsupported";
const domainEvidence: DomainCoverageEvidence = { type: "framework", value: "react" };
const domainModule: DomainModuleCoverage = {
  moduleId: "project", status: "completed", scopes: [], limitations: [],
};
const domainCoverage: DomainCoverage = {
  domain, applicability, status: domainStatus, coverageComplete: false,
  evidence: [domainEvidence], modules: [domainModule], limitations: [],
};
void [scope, full, error, comparison, finding, discovery, domainCoverage, AUDIT_DOMAINS];
`);
      const typeScript = resolve(
        repositoryRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "tsc.cmd" : "tsc",
      );
      const typeConsumer = run(typeScript, [
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--typeRoots",
        resolve(repositoryRoot, "node_modules", "@types"),
        "--types",
        "node",
        typeConsumerPath,
      ], temporaryRoot);
      expect(typeConsumer.status, typeConsumer.stderr || typeConsumer.stdout).toBe(0);

      const scanned = run(binary, [
        "audit",
        resolve(repositoryRoot, "test", "fixtures", "node-pass"),
        "--json",
      ], temporaryRoot);

      expect(scanned.status, scanned.stderr).toBe(0);
      const report = JSON.parse(scanned.stdout);
      expect(report).toMatchObject({
        schemaVersion: "1",
        tool: { name: "codebase-doctor", version: "0.1.3" },
      });
      expect(report.doctorRuns).toContainEqual(expect.objectContaining({
        doctorId: "database/rls",
        status: "skipped",
      }));
      expect(report.domainCoverage).toHaveLength(9);
      expect(report.domainCoverage).toContainEqual(expect.objectContaining({
        domain: "security",
        applicability: "detected",
        status: "partial",
        coverageComplete: false,
        modules: [
          expect.objectContaining({
            moduleId: "security/dependencies",
            status: "not-applicable",
          }),
          expect.objectContaining({
            moduleId: "security/secrets",
            status: "partial",
          }),
        ],
      }));

      const unsafe = run(binary, [
        "audit",
        resolve(repositoryRoot, "test", "fixtures", "sql-rls", "unsafe"),
        "--json",
        "--fail-on",
        "none",
      ], temporaryRoot);
      expect(unsafe.status, unsafe.stderr).toBe(0);
      const unsafeReport = JSON.parse(unsafe.stdout);
      expect(unsafeReport.auditScope).toMatchObject({ mode: "full", base: null });
      expect(unsafeReport.findings).toContainEqual(expect.objectContaining({
        doctorId: "database/sql-rls",
        impact: expect.any(String),
        remediationConstraints: expect.arrayContaining([expect.any(String)]),
        verification: {
          command: expect.any(String),
          expected: expect.stringMatching(/fingerprint.*absent.*coverage.*completed/i),
        },
      }));

      const gitRepository = join(temporaryRoot, "changed-repository");
      const initialized = run("git", ["init", "--quiet", "--initial-branch", "main", gitRepository]);
      expect(initialized.status, initialized.stderr).toBe(0);
      expect(run("git", ["config", "user.email", "doctor@example.invalid"], gitRepository).status)
        .toBe(0);
      expect(run("git", ["config", "user.name", "Codebase Doctor Test"], gitRepository).status)
        .toBe(0);
      const trackedSecret = generatedToken("ghp_");
      const ignoredSecret = generatedToken("glpat-");
      await writeFile(join(gitRepository, "tracked.txt"), "initial\n");
      await writeFile(join(gitRepository, ".gitignore"), ".env\n");
      await writeFile(join(gitRepository, "tracked.env"), `GITHUB_TOKEN=${trackedSecret}\n`);
      expect(run(
        "git",
        ["add", "--", "tracked.txt", ".gitignore", "tracked.env"],
        gitRepository,
      ).status).toBe(0);
      expect(run("git", ["commit", "--quiet", "--message", "initial"], gitRepository).status)
        .toBe(0);
      await writeFile(join(gitRepository, ".env"), `GITLAB_TOKEN=${ignoredSecret}\n`);

      const packedSecretAudit = run(binary, [
        "audit", gitRepository, "--json", "--fail-on", "none",
      ], temporaryRoot);
      expect(packedSecretAudit.status, packedSecretAudit.stderr).toBe(0);
      expect(packedSecretAudit.stdout).not.toContain(trackedSecret);
      expect(packedSecretAudit.stdout).not.toContain(ignoredSecret);
      const packedSecretReport = JSON.parse(packedSecretAudit.stdout);
      expect(packedSecretReport.findings.filter(({ doctorId }: { doctorId: string }) =>
        doctorId === "security/secrets"
      )).toEqual([expect.objectContaining({
        ruleId: "security/secrets/provider-token",
        location: expect.objectContaining({ path: "tracked.env" }),
      })]);
      expect(packedSecretReport.domainCoverage).toContainEqual(expect.objectContaining({
        domain: "security",
        status: "completed",
        coverageComplete: true,
      }));

      const dependencyRepository = join(temporaryRoot, "dependency-repository");
      await mkdir(dependencyRepository);
      const cleanManifest = JSON.stringify({
        name: "packed-dependency-fixture",
        private: true,
        packageManager: "npm@11.0.0",
        dependencies: { alpha: "^1.0.0" },
      }, null, 2);
      const cleanLock = JSON.stringify({
        name: "packed-dependency-fixture",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { alpha: "^1.0.0" } },
          "node_modules/alpha": {
            version: "1.0.0",
            resolved: "https://packages.example.invalid/alpha.tgz",
            integrity: "sha512-QUJDREVGRw==",
          },
        },
      }, null, 2);
      await writeFile(join(dependencyRepository, "package.json"), cleanManifest);
      await writeFile(join(dependencyRepository, "package-lock.json"), cleanLock);

      const packedCleanDependencies = run(binary, [
        "audit", dependencyRepository, "--json", "--fail-on", "none",
      ], temporaryRoot);
      expect(packedCleanDependencies.status, packedCleanDependencies.stderr).toBe(0);
      const cleanDependencyReport = JSON.parse(packedCleanDependencies.stdout);
      expect(cleanDependencyReport.findings.filter(({ doctorId }: { doctorId: string }) =>
        doctorId === "security/dependencies"
      )).toEqual([]);
      expect(cleanDependencyReport.coverage).toContainEqual(expect.objectContaining({
        moduleId: "security/dependencies",
        status: "completed",
        scope: "full:.",
      }));
      expect(await readFile(join(dependencyRepository, "package.json"), "utf8"))
        .toBe(cleanManifest);
      expect(await readFile(join(dependencyRepository, "package-lock.json"), "utf8"))
        .toBe(cleanLock);

      const dependencyCredential = generatedToken("source-");
      const insecureSource =
        `http://user:${dependencyCredential}@packages.example.invalid/alpha.tgz?token=${dependencyCredential}`;
      const unsafeManifest = JSON.stringify({
        name: "packed-dependency-fixture",
        private: true,
        packageManager: "npm@11.0.0",
        dependencies: { alpha: insecureSource },
      }, null, 2);
      const unsafeLock = JSON.stringify({
        name: "packed-dependency-fixture",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { alpha: "^2.0.0" } },
          "node_modules/alpha": {
            version: "1.0.0",
            resolved: insecureSource,
          },
          "node_modules/beta": {
            version: "2.0.0",
            resolved: "https://packages.example.invalid/beta.tgz",
          },
        },
      }, null, 2);
      await writeFile(join(dependencyRepository, "package.json"), unsafeManifest);
      await writeFile(join(dependencyRepository, "package-lock.json"), unsafeLock);

      const packedUnsafeDependencies = run(binary, [
        "audit", dependencyRepository, "--json", "--fail-on", "none",
      ], temporaryRoot);
      expect(packedUnsafeDependencies.status, packedUnsafeDependencies.stderr).toBe(0);
      expect(packedUnsafeDependencies.stdout).not.toContain(dependencyCredential);
      expect(packedUnsafeDependencies.stderr).not.toContain(dependencyCredential);
      const unsafeDependencyReport = JSON.parse(packedUnsafeDependencies.stdout);
      expect(unsafeDependencyReport.findings
        .filter(({ doctorId }: { doctorId: string }) => doctorId === "security/dependencies")
        .map(({ ruleId }: { ruleId: string }) => ruleId))
        .toEqual(expect.arrayContaining([
          "security/dependencies/manifest-lock-drift",
          "security/dependencies/insecure-source",
          "security/dependencies/missing-integrity",
        ]));
      expect(await readFile(join(dependencyRepository, "package.json"), "utf8"))
        .toBe(unsafeManifest);
      expect(await readFile(join(dependencyRepository, "package-lock.json"), "utf8"))
        .toBe(unsafeLock);

      const unsupportedRepository = join(temporaryRoot, "unsupported-dependency-repository");
      await mkdir(unsupportedRepository);
      await writeFile(join(unsupportedRepository, "package.json"), JSON.stringify({
        name: "packed-pnpm-fixture",
        packageManager: "pnpm@10.0.0",
        dependencies: { alpha: "^1.0.0" },
      }));
      await writeFile(join(unsupportedRepository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const packedUnsupportedDependencies = run(binary, [
        "audit", unsupportedRepository, "--json", "--fail-on", "none",
      ], temporaryRoot);
      expect(packedUnsupportedDependencies.status, packedUnsupportedDependencies.stderr).toBe(0);
      const unsupportedDependencyReport = JSON.parse(packedUnsupportedDependencies.stdout);
      expect(unsupportedDependencyReport.findings.filter(({ doctorId }: { doctorId: string }) =>
        doctorId === "security/dependencies"
      )).toEqual([]);
      expect(unsupportedDependencyReport.coverage).toContainEqual(expect.objectContaining({
        moduleId: "security/dependencies",
        status: "unsupported",
      }));

      await writeFile(join(gitRepository, "tracked.txt"), "changed\n");
      await writeFile(join(gitRepository, "untracked.txt"), "untracked\n");

      const changed = run(binary, [
        "audit", gitRepository, "--changed", "--json", "--fail-on", "none",
      ], temporaryRoot);
      expect(changed.status, changed.stderr).toBe(0);
      const changedReport = JSON.parse(changed.stdout);
      expect(changedReport.auditScope).toMatchObject({
        mode: "changed",
        base: { kind: "head", requestedRef: null },
        changes: [
          { status: "modified", path: "tracked.txt" },
          { status: "untracked", path: "untracked.txt" },
        ],
      });
      expect(changedReport.domainCoverage).toHaveLength(9);
      expect(changedReport.domainCoverage.map(({ domain }: { domain: string }) => domain)).toEqual([
        "repository",
        "validation",
        "frontend",
        "backend",
        "database",
        "security",
        "infrastructure",
        "performance",
        "ai",
      ]);

      const based = run(binary, [
        "audit", gitRepository, "--changed", "--base", "main", "--json", "--fail-on", "none",
      ], temporaryRoot);
      expect(based.status, based.stderr).toBe(0);
      expect(JSON.parse(based.stdout).auditScope.base).toMatchObject({
        kind: "merge-base",
        requestedRef: "main",
      });

      for (const args of [
        ["audit", gitRepository, "--changed", "--base"],
        ["audit", gitRepository, "--changed", "--base", "missing-ref", "--json"],
      ]) {
        const invalid = run(binary, args, temporaryRoot);
        expect(invalid.status, invalid.stderr || invalid.stdout).toBe(2);
        expect(invalid.stdout).toBe("");
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
