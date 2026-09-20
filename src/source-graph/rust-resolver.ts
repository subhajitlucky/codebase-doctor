import { posix } from "node:path";
import type { DetectedProject } from "../workspace/types.js";
import { ownerProjectOf } from "./ownership.js";
import { importSpecifier, type SafeImportReference } from "./references.js";
import type { SourceResolution } from "./resolver.js";

export interface RustResolverContext {
  readonly projects: readonly DetectedProject[];
  readonly sourcePaths: ReadonlySet<string>;
}

export function isRustSourcePath(path: string): boolean {
  return posix.extname(path).toLowerCase() === ".rs";
}

function crateRootFor(projectRoot: string, sourcePaths: ReadonlySet<string>): string | undefined {
  const srcRoot = projectRoot === "." ? "src" : `${projectRoot}/src`;
  if (![...sourcePaths].some((path) => path.startsWith(`${srcRoot}/`))) return undefined;
  if (sourcePaths.has(`${srcRoot}/lib.rs`)) return `${srcRoot}/lib.rs`;
  if (sourcePaths.has(`${srcRoot}/main.rs`)) return `${srcRoot}/main.rs`;
  return undefined;
}

function moduleDirectoryOf(filePath: string, crateRoot: string): string {
  if (filePath === crateRoot) return posix.dirname(crateRoot);
  if (filePath.endsWith("/mod.rs")) return posix.dirname(filePath);
  return filePath.slice(0, -".rs".length);
}

function moduleCandidates(baseDir: string, segments: readonly string[]): string[] {
  const joined = segments.length === 0
    ? baseDir
    : baseDir === "." ? segments.join("/") : `${baseDir}/${segments.join("/")}`;
  return [`${joined}.rs`, `${joined}/mod.rs`];
}

function rustFilesIn(directory: string, sourcePaths: ReadonlySet<string>): string[] {
  return [...sourcePaths]
    .filter((path) => isRustSourcePath(path) && posix.dirname(path) === directory)
    .sort();
}

function unprovenInternal(
  importerPath: string,
  targetPath: string,
  reason: string,
): SourceResolution {
  return {
    kind: "internal",
    targetPath,
    targetExists: false,
    limitations: [`${importerPath}: ${reason}`],
  };
}

/**
 * Resolves Rust `mod` declarations and `use` paths for crates rooted at
 * `src/lib.rs` or `src/main.rs`. Brace groups are already expanded by the
 * parser. Missing targets never carry a missing-target proof because build
 * scripts, macros, and path attributes can generate or relocate modules.
 */
export function resolveRustImport(
  importerPath: string,
  reference: SafeImportReference,
  context: RustResolverContext,
): SourceResolution {
  const specifier = importSpecifier(reference);
  if (specifier === undefined || specifier.length === 0) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Rust import value is unavailable.`],
    };
  }

  const owner = ownerProjectOf(importerPath, context.projects);
  const crateRoot = owner === undefined ? undefined : crateRootFor(owner.root, context.sourcePaths);
  if (crateRoot === undefined) {
    return { kind: "external", limitations: [] };
  }
  const sourceRoot = posix.dirname(crateRoot);
  const moduleDirectory = moduleDirectoryOf(importerPath, crateRoot);

  if (reference.kind === "module") {
    const candidates = moduleCandidates(moduleDirectory, [specifier]);
    const existing = candidates.find((candidate) => context.sourcePaths.has(candidate));
    if (existing !== undefined) {
      return { kind: "internal", targetPath: existing, targetExists: true, limitations: [] };
    }
    return unprovenInternal(
      importerPath,
      candidates[0]!,
      "Rust module declaration target is not present in the current inventory; path attributes or cfg were not assumed.",
    );
  }

  const segments = specifier.split("::");
  let base: string;
  let rest: readonly string[];
  if (segments[0] === "crate") {
    base = sourceRoot;
    rest = segments.slice(1);
  } else if (segments[0] === "self") {
    base = moduleDirectory;
    rest = segments.slice(1);
  } else if (segments[0] === "super") {
    base = moduleDirectory;
    let cursor = 0;
    while (segments[cursor] === "super") {
      base = posix.dirname(base);
      cursor += 1;
    }
    rest = segments.slice(cursor);
  } else {
    return { kind: "external", limitations: [] };
  }

  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Rust import escapes the crate root.`],
    };
  }

  if (rest.at(-1) === "*") {
    const wildcardSegments = rest.slice(0, -1);
    const directory = wildcardSegments.length === 0
      ? base
      : base === "." ? wildcardSegments.join("/") : `${base}/${wildcardSegments.join("/")}`;
    if (rustFilesIn(directory, context.sourcePaths).length > 0) {
      return {
        kind: "external",
        limitations: [`${importerPath}: internal wildcard Rust import was not expanded to file edges.`],
      };
    }
    return { kind: "external", limitations: [] };
  }

  if (rest.length === 0) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Rust import specifier is unsupported.`],
    };
  }

  const full = moduleCandidates(base, rest);
  const fullExisting = full.find((candidate) => context.sourcePaths.has(candidate));
  if (fullExisting !== undefined) {
    return { kind: "internal", targetPath: fullExisting, targetExists: true, limitations: [] };
  }

  if (rest.length >= 1) {
    const parent = moduleCandidates(base, rest.slice(0, -1));
    const parentExisting = parent.find((candidate) => context.sourcePaths.has(candidate));
    if (parentExisting !== undefined) {
      return { kind: "internal", targetPath: parentExisting, targetExists: true, limitations: [] };
    }
  }

  return unprovenInternal(
    importerPath,
    full[0]!,
    "Rust use target is not present in the current inventory; build scripts or macros may generate it.",
  );
}
