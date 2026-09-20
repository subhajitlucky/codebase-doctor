import { posix } from "node:path";
import type { DetectedProject, FileRecord } from "../workspace/types.js";
import type { SourceResolution } from "./resolver.js";

export interface PythonResolverContext {
  readonly files: readonly FileRecord[];
  readonly projects: readonly DetectedProject[];
  readonly sourcePaths: ReadonlySet<string>;
}

export function isPythonSourcePath(path: string): boolean {
  return posix.extname(path).toLowerCase() === ".py";
}

function moduleCandidates(baseDir: string, modulePath: string): string[] {
  const joined = modulePath.length === 0
    ? baseDir
    : baseDir === "." ? modulePath : `${baseDir}/${modulePath}`;
  return joined === "." ? ["__init__.py"] : [`${joined}.py`, `${joined}/__init__.py`];
}

function ownerProject(
  importerPath: string,
  projects: readonly DetectedProject[],
): DetectedProject | undefined {
  return [...projects]
    .filter((project) =>
      project.root === "." ||
      importerPath === project.root ||
      importerPath.startsWith(`${project.root}/`)
    )
    .sort((left, right) =>
      (right.root === "." ? 0 : right.root.split("/").length) -
        (left.root === "." ? 0 : left.root.split("/").length) ||
      left.id.localeCompare(right.id)
    )[0];
}

function resolveRelative(
  importerPath: string,
  specifier: string,
  sourcePaths: ReadonlySet<string>,
): SourceResolution {
  let dots = 0;
  while (specifier[dots] === ".") dots += 1;
  const modulePath = specifier.slice(dots).replaceAll(".", "/");
  let baseDir = posix.dirname(importerPath);
  for (let level = 1; level < dots; level += 1) baseDir = posix.dirname(baseDir);
  if (baseDir === ".." || baseDir.startsWith("../") || posix.isAbsolute(baseDir)) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Python relative import escapes the repository.`],
    };
  }

  const candidates = moduleCandidates(baseDir, modulePath);
  const existing = candidates.find((candidate) => sourcePaths.has(candidate));
  if (existing !== undefined) {
    return { kind: "internal", targetPath: existing, targetExists: true, limitations: [] };
  }
  if (modulePath.length === 0) {
    return {
      kind: "unsupported",
      limitations: [
        `${importerPath}: bare relative import may target a package attribute; module resolution was not provable.`,
      ],
    };
  }
  return {
    kind: "internal",
    targetPath: candidates[0]!,
    targetExists: false,
    missingTargetProof: "relative-explicit",
    limitations: [`${importerPath}: relative Python module was not found in the current inventory.`],
  };
}

function resolveAbsolute(
  importerPath: string,
  modulePath: string,
  context: PythonResolverContext,
): SourceResolution {
  const project = ownerProject(importerPath, context.projects);
  const roots: string[] = [];
  if (project !== undefined) {
    roots.push(project.root);
    const srcRoot = project.root === "." ? "src" : `${project.root}/src`;
    if ([...context.sourcePaths].some((path) => path.startsWith(`${srcRoot}/`))) {
      roots.push(srcRoot);
    }
  }
  if (roots.length === 0) roots.push(".");

  const first = modulePath.split("/")[0]!;
  const internalRoots = roots.filter((root) =>
    context.sourcePaths.has(`${root === "." ? "" : `${root}/`}${first}.py`) ||
    context.sourcePaths.has(`${root === "." ? "" : `${root}/`}${first}/__init__.py`)
  );
  if (internalRoots.length === 0) {
    return { kind: "external", limitations: [] };
  }
  if (internalRoots.length > 1) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Python import root is ambiguous across project layouts.`],
    };
  }

  const root = internalRoots[0]!;
  const candidates = moduleCandidates(root, modulePath);
  const existing = candidates.filter((candidate) => context.sourcePaths.has(candidate));
  if (existing.length === 1) {
    return { kind: "internal", targetPath: existing[0]!, targetExists: true, limitations: [] };
  }
  if (existing.length > 1) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Python module resolves ambiguously.`],
    };
  }
  return {
    kind: "internal",
    targetPath: candidates[0]!,
    targetExists: false,
    limitations: [
      `${importerPath}: Python module is not present in the current inventory; namespace or path-based resolution was not provable.`,
    ],
  };
}

/**
 * Resolves Python imports for the source graph. Relative module imports carry
 * the relative-explicit missing-target proof; bare `from . import name`
 * attribute imports and absolute internal imports without a present file are
 * edges or limitations without a missing-target proof, because Python can
 * resolve them through attributes, namespace packages, or path configuration.
 */
export function resolvePythonImport(
  importerPath: string,
  specifier: string,
  context: PythonResolverContext,
): SourceResolution {
  if (specifier.includes("\0")) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Python import escapes the repository.`],
    };
  }
  if (specifier.startsWith(".")) {
    return resolveRelative(importerPath, specifier, context.sourcePaths);
  }
  if (specifier.length === 0 || specifier.includes("/") || /\s/u.test(specifier)) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Python import specifier is unsupported.`],
    };
  }
  return resolveAbsolute(importerPath, specifier.replaceAll(".", "/"), context);
}
