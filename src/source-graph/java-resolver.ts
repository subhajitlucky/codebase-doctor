import { posix } from "node:path";
import type { DetectedProject } from "../workspace/types.js";
import { ownerProjectOf } from "./ownership.js";
import { importSpecifier, type SafeImportReference } from "./references.js";
import type { SourceResolution } from "./resolver.js";

export interface JavaResolverContext {
  readonly projects: readonly DetectedProject[];
  readonly sourcePaths: ReadonlySet<string>;
}

export function isJavaSourcePath(path: string): boolean {
  return posix.extname(path).toLowerCase() === ".java";
}

function packageRoot(importerPath: string, projectRoot: string | undefined): string {
  const segments = importerPath.split("/");
  for (let index = segments.length - 1; index >= 1; index -= 1) {
    if (segments[index] !== "java") continue;
    const previous = segments[index - 1];
    const before = index >= 2 ? segments[index - 2] : undefined;
    if (previous === "src" || previous === "main" || previous === "test" || before === "src") {
      return segments.slice(0, index + 1).join("/");
    }
  }
  return projectRoot ?? posix.dirname(importerPath);
}

function javaFilesIn(directory: string, sourcePaths: ReadonlySet<string>): string[] {
  return [...sourcePaths]
    .filter((path) => isJavaSourcePath(path) && posix.dirname(path) === directory)
    .sort();
}

/**
 * Resolves Java imports from standard Maven/Gradle package roots
 * (`src/main/java`, `src/test/java`, and `src/*\/java`). Wildcard imports are
 * never edges; an internal wildcard is reported as a limitation. Static
 * imports fall back from a member path to its declaring class file. Missing
 * targets never carry a missing-target proof in this release because Java
 * classes can be generated or provided by a dependency with the same package.
 */
export function resolveJavaImport(
  importerPath: string,
  reference: SafeImportReference,
  context: JavaResolverContext,
): SourceResolution {
  const specifier = importSpecifier(reference);
  if (specifier === undefined) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Java import value is unavailable.`],
    };
  }
  if (specifier.length === 0 || specifier.includes("\0") || /\s/u.test(specifier)) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Java import specifier is unsupported.`],
    };
  }

  const owner = ownerProjectOf(importerPath, context.projects);
  const root = packageRoot(importerPath, owner?.root);
  const wildcard = specifier.endsWith(".*");
  const raw = wildcard ? specifier.slice(0, -2) : specifier;
  if (raw.length === 0 || raw.includes("*") || raw.startsWith(".") || raw.endsWith(".")) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Java import specifier is unsupported.`],
    };
  }

  const relative = raw.replaceAll(".", "/");
  if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Java import escapes the package root.`],
    };
  }

  const classPath = `${root}/${relative}.java`;
  const packageDirectory = posix.dirname(classPath);

  if (wildcard) {
    const wildcardDirectory = `${root}/${relative}`;
    if (javaFilesIn(wildcardDirectory, context.sourcePaths).length > 0) {
      return {
        kind: "external",
        limitations: [
          `${importerPath}: internal wildcard Java import was not expanded to file edges.`,
        ],
      };
    }
    return { kind: "external", limitations: [] };
  }

  if (context.sourcePaths.has(classPath)) {
    return { kind: "internal", targetPath: classPath, targetExists: true, limitations: [] };
  }

  if (reference.kind === "static-import") {
    const parent = posix.dirname(relative);
    const parentClassPath = parent === "." ? undefined : `${root}/${parent}.java`;
    if (parentClassPath !== undefined && context.sourcePaths.has(parentClassPath)) {
      return { kind: "internal", targetPath: parentClassPath, targetExists: true, limitations: [] };
    }
  }

  if (javaFilesIn(packageDirectory, context.sourcePaths).length > 0) {
    return {
      kind: "internal",
      targetPath: classPath,
      targetExists: false,
      limitations: [
        `${importerPath}: Java import target is not present in the current inventory; generated or dependency sources were not assumed.`,
      ],
    };
  }

  return { kind: "external", limitations: [] };
}
