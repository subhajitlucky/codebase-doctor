import { describe, expect, it } from "vitest";
import {
  analyzePythonTarget,
  comparePythonVersions,
  parsePythonLock,
  parsePythonManifest,
  satisfiesPythonSpec,
  selectPythonTargets,
  type PythonAuditTarget,
} from "../../../../../src/audits/security/dependencies/python.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { AuditScope } from "../../../../../src/scope/types.js";
import type { DetectedProject, FileRecord, ProjectSnapshot } from "../../../../../src/workspace/types.js";

function file(path: string): FileRecord {
  return { path, kind: "file", size: 100 };
}

function project(
  id: string,
  root: string,
  manifestPaths: string[] = [`${root}/pyproject.toml`],
): DetectedProject {
  return {
    id,
    root,
    ecosystems: ["python"],
    languages: ["python"],
    frameworks: [],
    manifestPaths,
    executionSupport: "supported",
  };
}

function snapshotWith(
  files: FileRecord[],
  projects: DetectedProject[],
  auditScope: AuditScope = fullAuditScope(),
): ProjectSnapshot {
  return {
    root: "/repo",
    files,
    manifests: [],
    projects,
    workspaces: [],
    auditScope,
  };
}

const POETRY_LOCK = [
  "[[package]]",
  'name = "requests"',
  'version = "2.31.0"',
  'files = [{file = "requests-2.31.0-py3-none-any.whl", hash = "sha256:abc"}]',
  "",
  "[[package]]",
  'name = "mylib"',
  'version = "0.1.0"',
  "",
  "[package.source]",
  'type = "git"',
  'url = "https://github.com/org/mylib.git"',
  'reference = "main"',
  'resolved_reference = "0123456789abcdef0123456789abcdef01234567"',
  "",
  "[[package]]",
  'name = "evil"',
  'version = "1.0"',
  "",
  "[package.source]",
  'type = "git"',
  'url = "http://git.example.invalid/evil.git"',
  'reference = "main"',
  "",
].join("\n");

const UV_LOCK = [
  "version = 1",
  "",
  "[[package]]",
  'name = "alpha"',
  'version = "1.0.0"',
  'source = { registry = "https://pypi.org/simple" }',
  'sdist = { url = "https://example.invalid/a.tgz", hash = "sha256:abc", size = 10 }',
  "",
  "[[package]]",
  'name = "beta"',
  'version = "2.0"',
  'source = { git = "https://github.com/org/beta.git?4c9b3e3a4c9b3e3a4c9b3e3a4c9b3e3a4c9b3e3a" }',
  "",
].join("\n");

describe("parsePythonLock", () => {
  it("extracts registry packages with integrity evidence", () => {
    const summary = parsePythonLock("poetry", "poetry.lock", POETRY_LOCK);

    expect(summary.packages.find(({ name }) => name === "requests")).toMatchObject({
      version: "2.31.0",
      source: "registry",
      integrity: true,
    });
    expect(summary.limitations).toEqual([]);
  });

  it("classifies git sources with pinned and mutable references", () => {
    const summary = parsePythonLock("poetry", "poetry.lock", POETRY_LOCK);

    expect(summary.packages.find(({ name }) => name === "mylib")).toMatchObject({
      source: "git",
      url: "https://github.com/org/mylib.git",
      reference: "main",
      resolvedReference: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(summary.packages.find(({ name }) => name === "evil")).toMatchObject({
      source: "git",
      url: "http://git.example.invalid/evil.git",
    });
  });

  it("parses uv git sources with revision queries", () => {
    const summary = parsePythonLock("uv", "uv.lock", UV_LOCK);

    expect(summary.packages.find(({ name }) => name === "alpha")).toMatchObject({
      source: "registry",
      integrity: true,
    });
    const beta = summary.packages.find(({ name }) => name === "beta");
    expect(beta?.source).toBe("git");
    expect(beta?.resolvedReference).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports packages without hash evidence as integrity-free", () => {
    const summary = parsePythonLock(
      "poetry",
      "poetry.lock",
      ['[[package]]', 'name = "bare"', 'version = "1.0"'].join("\n"),
    );

    expect(summary.packages).toHaveLength(1);
    expect(summary.packages[0]).toMatchObject({ name: "bare", integrity: false });
  });

  it("reports empty content as a limitation", () => {
    const summary = parsePythonLock("poetry", "poetry.lock", "# empty\n");

    expect(summary.packages).toEqual([]);
    expect(summary.limitations.join(" ")).toContain("no package entries");
  });
});

describe("parsePythonManifest", () => {
  it("reads Poetry and PEP 621 declarations", () => {
    const summary = parsePythonManifest(
      "pyproject.toml",
      [
        "[tool.poetry.dependencies]",
        'python = ">=3.9"',
        'requests = "^2.0"',
        'flask = {version = "~2.0", extras = ["async"]}',
        'local = {path = "../local", develop = true}',
        'repo = {git = "https://github.com/org/repo.git", rev = "main"}',
        "",
        "[project]",
        'dependencies = ["click>=8", "rich; python_version > \\"3.8\\""]',
        "",
      ].join("\n"),
    );

    expect(summary?.deps).toEqual([
      { name: "click", spec: ">=8", flavor: "pep621", markers: false },
      { name: "flask", spec: "~2.0", flavor: "poetry", markers: false },
      { name: "repo", spec: "git+https://github.com/org/repo.git#main", flavor: "poetry", markers: false },
      { name: "requests", spec: "^2.0", flavor: "poetry", markers: false },
      { name: "rich", spec: "", flavor: "pep621", markers: true },
    ]);
    expect(summary?.limitations).toEqual([]);
  });

  it("returns undefined without supported sections", () => {
    expect(parsePythonManifest("pyproject.toml", "[tool.black]\n")).toBeUndefined();
  });

  it("records unparseable declarations as limitations", () => {
    const summary = parsePythonManifest(
      "pyproject.toml",
      ["[tool.poetry.dependencies]", "weird = {multiple = true}"].join("\n"),
    );

    expect(summary?.deps).toEqual([]);
    expect(summary?.limitations.join(" ")).toContain("was skipped");
  });
});

describe("comparePythonVersions and satisfiesPythonSpec", () => {
  it.each([
    ["1.0", "1.0.0", 0],
    ["1.2.3", "1.2.4", -1],
    ["2.0", "1.9.9", 1],
    ["1.0a1", "1.0", -1],
    ["1.0.post1", "1.0", 1],
  ])("compares %s with %s", (left, right, expected) => {
    expect(Math.sign(comparePythonVersions(left, right) ?? NaN)).toBe(expected);
  });

  it("returns undefined for epochs", () => {
    expect(comparePythonVersions("1!2.0", "2.0")).toBeUndefined();
  });

  it.each([
    ["2.31.0", "^2.0", "poetry", true],
    ["3.0.0", "^2.0", "poetry", false],
    ["2.0.5", "~2.0", "poetry", true],
    ["2.1.0", "~2.0", "poetry", false],
    ["0.2.5", "^0.2.0", "poetry", true],
    ["0.3.0", "^0.2.0", "poetry", false],
    ["1.4.5", "~=1.4.2", "pep621", true],
    ["1.5.0", "~=1.4.2", "pep621", false],
    ["2.0", "==2.*", "pep621", true],
    ["2.1", "==2.*", "pep621", true],
    ["3.0", "==2.*", "pep621", false],
    ["1.5", ">=1.0,<2.0", "pep621", true],
    ["2.5", ">=1.0,<2.0", "pep621", false],
    ["8.1.3", "", "pep621", true],
    ["8.1.3", "*", "poetry", true],
    ["8.1.3", "8", "poetry", true],
    ["9.0.0", "8", "poetry", false],
    ["8.1.3", "8", "pep621", true],
  ])("decides %s against %s (%s)", (version, spec, flavor, expected) => {
    expect(satisfiesPythonSpec(version, spec, flavor as "poetry" | "pep621")).toBe(expected);
  });

  it("withholds judgment on unions", () => {
    expect(satisfiesPythonSpec("1.0", ">=1.0 || >=2.0", "pep621")).toBeUndefined();
  });
});

describe("selectPythonTargets", () => {
  it("groups lockfile projects under their governing root", () => {
    const selection = selectPythonTargets(snapshotWith(
      [file("poetry.lock"), file("pyproject.toml")],
      [project("python", ".")],
    ));

    expect(selection.targets).toHaveLength(1);
    expect(selection.targets[0]).toMatchObject({
      lockRoot: ".",
      manager: "poetry",
      scope: "full",
    });
    expect(selection.targets[0]?.lockfile?.path).toBe("poetry.lock");
    expect(selection.handledProjectIds.has("python")).toBe(true);
  });

  it("creates manifest-only targets for missing-lockfile analysis", () => {
    const selection = selectPythonTargets(snapshotWith(
      [file("pyproject.toml")],
      [project("python", ".")],
    ));

    expect(selection.targets).toHaveLength(1);
    expect(selection.targets[0]?.lockfile).toBeUndefined();
    expect(selection.handledProjectIds.has("python")).toBe(true);
  });

  it("leaves projects without locks or manifests unsupported", () => {
    const selection = selectPythonTargets(snapshotWith(
      [file("setup.py")],
      [project("python", ".", ["setup.py"])],
    ));

    expect(selection.targets).toEqual([]);
    expect(selection.handledProjectIds.size).toBe(0);
  });

  it("withholds ambiguous competing lockfiles", () => {
    const selection = selectPythonTargets(snapshotWith(
      [file("poetry.lock"), file("uv.lock"), file("pyproject.toml")],
      [project("python", ".")],
    ));

    expect(selection.targets).toEqual([]);
    expect(selection.handledProjectIds.has("python")).toBe(true);
    expect(selection.limitations.join(" ")).toContain("multiple Python lockfiles");
  });
});

describe("analyzePythonTarget", () => {
  function target(overrides: Partial<PythonAuditTarget> = {}): PythonAuditTarget {
    return {
      lockRoot: ".",
      manager: "poetry",
      coveredProjects: [{ projectId: "python", root: ".", manifestPath: "pyproject.toml" }],
      competingLockfilePaths: [],
      limitations: [],
      scope: "full",
      ...overrides,
    };
  }

  const manifest = {
    path: "pyproject.toml",
    deps: [
      { name: "requests", spec: "^2.0", flavor: "poetry" as const, markers: false },
      { name: "missing", spec: "==1.0", flavor: "poetry" as const, markers: false },
      { name: "stale", spec: "==1.0", flavor: "poetry" as const, markers: false },
    ],
    limitations: [],
  };

  it("reports drift, mutable, insecure, and integrity findings", () => {
    const { matches } = analyzePythonTarget({
      target: target({ lockfile: file("poetry.lock") }),
      lock: parsePythonLock("poetry", "poetry.lock", [
        POETRY_LOCK,
        "",
        "[[package]]",
        'name = "stale"',
        'version = "2.0"',
        'files = [{file = "s.whl", hash = "sha256:x"}]',
        "",
        "[[package]]",
        'name = "bare"',
        'version = "1.0"',
        "",
      ].join("\n")),
      manifests: new Map([["pyproject.toml", manifest]]),
    });

    expect(matches).toContainEqual(expect.objectContaining({
      family: "mutable-git-source",
    }));
    expect(matches).toContainEqual(expect.objectContaining({
      family: "insecure-source",
    }));
    expect(matches).toContainEqual(expect.objectContaining({
      family: "missing-integrity",
    }));
    expect(matches).toContainEqual(expect.objectContaining({
      family: "manifest-lock-drift",
    }));
  });

  it("reports missing lockfiles only with external dependencies", () => {
    const withDeps = analyzePythonTarget({
      target: target(),
      manifests: new Map([["pyproject.toml", manifest]]),
    });
    expect(withDeps.matches).toContainEqual(expect.objectContaining({
      family: "missing-lockfile",
    }));

    const withoutDeps = analyzePythonTarget({
      target: target(),
      manifests: new Map([["pyproject.toml", { path: "pyproject.toml", deps: [], limitations: [] }]]),
    });
    expect(withoutDeps.matches).toEqual([]);
  });

  it("reports competing lockfiles", () => {
    const { matches } = analyzePythonTarget({
      target: target({ competingLockfilePaths: ["uv.lock"] }),
      manifests: new Map(),
    });

    expect(matches).toContainEqual(expect.objectContaining({
      family: "competing-lockfiles",
      path: "uv.lock",
    }));
  });
});
