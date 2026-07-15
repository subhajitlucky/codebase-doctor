import { describe, expect, it } from "vitest";
import { planJavaScriptChecks } from "../../../src/doctors/checks/javascript.js";
import { planPythonChecks } from "../../../src/doctors/checks/python.js";
import { planChecks } from "../../../src/doctors/checks/planner.js";
import type {
  DetectedProject,
  FileRecord,
  ManifestRecord,
  PackageManager,
  ProjectSnapshot,
} from "../../../src/workspace/types.js";

function file(path: string): FileRecord {
  return { path, kind: "file", size: 1 };
}

function nodeProject(manager: PackageManager): DetectedProject {
  return {
    id: "root",
    root: ".",
    ecosystems: ["node"],
    languages: ["javascript", "typescript"],
    frameworks: [],
    packageManager: manager,
    manifestPaths: ["package.json"],
    executionSupport: "supported",
  };
}

function pythonProject(root = "."): DetectedProject {
  return {
    id: root === "." ? "root" : `project:${root}`,
    root,
    ecosystems: ["python"],
    languages: ["python"],
    frameworks: [],
    manifestPaths: [root === "." ? "pyproject.toml" : `${root}/pyproject.toml`],
    executionSupport: "supported",
  };
}

function packageManifest(scripts: Record<string, string>): ManifestRecord {
  return {
    kind: "package-json",
    path: "package.json",
    status: "valid",
    data: { scripts },
  };
}

function snapshot(overrides: Partial<ProjectSnapshot>): ProjectSnapshot {
  return {
    root: "/tmp/repository",
    files: [],
    manifests: [],
    projects: [],
    workspaces: [],
    ...overrides,
  };
}

describe("JavaScript check planning", () => {
  it.each([
    ["npm", "npm"],
    ["pnpm", "pnpm"],
    ["yarn", "yarn"],
    ["bun", "bun"],
  ] as const)("uses explicit %s run arguments", (manager, executable) => {
    const plans = planJavaScriptChecks(snapshot({
      projects: [nodeProject(manager)],
      manifests: [packageManifest({ test: "vitest" })],
    }), 30_000);

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      executable,
      args: ["run", "test"],
      cwd: "/tmp/repository",
      timeoutMs: 30_000,
    });
  });

  it("plans only declared allowlisted scripts in deterministic order", () => {
    const plans = planJavaScriptChecks(snapshot({
      projects: [nodeProject("npm")],
      manifests: [packageManifest({
        build: "vite build",
        postinstall: "danger",
        test: "vitest",
        arbitrary: "do something",
        lint: "eslint .",
        prepare: "danger",
        typecheck: "tsc --noEmit",
        install: "danger",
        preinstall: "danger",
      })],
    }), 60_000);

    expect(plans.map(({ args }) => args.at(-1))).toEqual([
      "typecheck",
      "test",
      "lint",
      "build",
    ]);
  });

  it("uses check only as the fallback for a missing typecheck script", () => {
    const plans = planJavaScriptChecks(snapshot({
      projects: [nodeProject("pnpm")],
      manifests: [packageManifest({ check: "tsc", test: "vitest" })],
    }), 60_000);

    expect(plans.map(({ args }) => args.at(-1))).toEqual(["check", "test"]);
  });
});

describe("Python check planning", () => {
  it("plans tools only when dedicated test or static configuration is visible", () => {
    const plans = planPythonChecks(snapshot({
      projects: [pythonProject()],
      files: [
        file("pyproject.toml"),
        file("tests/test_api.py"),
        file("ruff.toml"),
        file("mypy.ini"),
      ],
    }), 45_000);

    expect(plans.map(({ executable, args }) => [executable, ...args])).toEqual([
      ["python", "-m", "pytest"],
      ["ruff", "check", "."],
      ["mypy", "."],
    ]);
    expect(plans.every(({ cwd }) => cwd === "/tmp/repository")).toBe(true);
  });

  it("does not infer Python tools from pyproject.toml alone", () => {
    const plans = planPythonChecks(snapshot({
      projects: [pythonProject()],
      files: [file("pyproject.toml")],
    }), 45_000);

    expect(plans).toEqual([]);
  });

  it.each([
    ["uv.lock", "uv"],
    ["poetry.lock", "poetry"],
  ] as const)("prefers %s for configured tools", (lockfile, executable) => {
    const plans = planPythonChecks(snapshot({
      projects: [pythonProject("services/api")],
      files: [
        file(`services/api/${lockfile}`),
        file("services/api/pytest.ini"),
        file("services/api/.ruff.toml"),
        file("services/api/.mypy.ini"),
      ],
    }), 20_000);

    expect(plans.map(({ executable: command, args, cwd }) => ({ command, args, cwd }))).toEqual([
      { command: executable, args: ["run", "pytest"], cwd: "/tmp/repository/services/api" },
      { command: executable, args: ["run", "ruff", "check", "."], cwd: "/tmp/repository/services/api" },
      { command: executable, args: ["run", "mypy", "."], cwd: "/tmp/repository/services/api" },
    ]);
  });
});

describe("combined check planning", () => {
  it("returns immutable plans in stable adapter order", () => {
    const plans = planChecks(snapshot({
      projects: [pythonProject("services/api"), nodeProject("npm")],
      manifests: [packageManifest({ test: "vitest" })],
      files: [file("services/api/pytest.ini")],
    }), 10_000);

    expect(plans.map(({ id }) => id)).toEqual([
      "root:javascript:test",
      "project:services/api:python:pytest",
    ]);
    expect(Object.isFrozen(plans)).toBe(true);
  });
});
