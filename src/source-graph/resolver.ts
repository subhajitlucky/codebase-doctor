import { posix } from "node:path";
import type {
  DetectedProject,
  FileRecord,
  ManifestRecord,
} from "../workspace/types.js";
import {
  aliasPattern,
  aliasTargets,
  sourceConfigForPath,
  type SourceAliasConfig,
  type SafeSourceAlias,
} from "./config.js";
import { importSpecifier, type SafeImportReference } from "./parser.js";
import { isSupportedSourcePath } from "./selection.js";
import {
  classifyMissingRelativeTarget,
  type GeneratedTargetEvidence,
  type MissingTargetDisposition,
} from "./generated-targets.js";
import type { MissingTargetProof } from "./types.js";

type JsonObject = Record<string, unknown>;

export interface SourceResolverContext {
  readonly files: readonly FileRecord[];
  readonly manifests: readonly ManifestRecord[];
  readonly projects: readonly DetectedProject[];
  readonly configs: readonly SourceAliasConfig[];
  readonly generatedTargetEvidence?: GeneratedTargetEvidence;
}

export interface SourceResolverIndex extends SourceResolverContext {
  readonly sourcePaths: ReadonlySet<string>;
  readonly projectsByPackageName: ReadonlyMap<string, readonly DetectedProject[]>;
  readonly manifestByProjectId: ReadonlyMap<
    string,
    Extract<ManifestRecord, { status: "valid" }>
  >;
}

export type SourceResolution =
  | {
      readonly kind: "internal";
      readonly targetPath: string;
      readonly targetExists: boolean;
      readonly missingTargetProof?: MissingTargetProof;
      readonly limitations: readonly string[];
    }
  | {
      readonly kind: "external";
      readonly limitations: readonly string[];
    }
  | {
      readonly kind: "unsupported";
      readonly limitations: readonly string[];
    };

const TYPESCRIPT_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
] as const;
const JAVASCRIPT_EXTENSIONS = [
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
] as const;

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function normalizedRepositoryPath(base: string, value: string): string | undefined {
  if (value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) return undefined;
  const normalized = posix.normalize(posix.join(base === "." ? "" : base, value));
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function preferredExtensions(importerPath: string): readonly string[] {
  return [".ts", ".tsx", ".mts", ".cts"].includes(posix.extname(importerPath).toLowerCase())
    ? TYPESCRIPT_EXTENSIONS
    : JAVASCRIPT_EXTENSIONS;
}

function candidatePaths(basePath: string, target: string, importerPath: string): string[] | undefined {
  const normalized = normalizedRepositoryPath(basePath, target);
  if (normalized === undefined) return undefined;
  const extension = posix.extname(normalized).toLowerCase();
  const candidates = [normalized];
  if (extension.length === 0) {
    for (const candidateExtension of preferredExtensions(importerPath)) {
      candidates.push(`${normalized}${candidateExtension}`);
    }
    for (const candidateExtension of preferredExtensions(importerPath)) {
      candidates.push(`${normalized}/index${candidateExtension}`);
    }
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = normalized.slice(0, -extension.length);
    const substitutions: Record<string, readonly string[]> = {
      ".js": [".ts", ".tsx"],
      ".jsx": [".tsx"],
      ".mjs": [".mts"],
      ".cjs": [".cts"],
    };
    for (const substitute of substitutions[extension] ?? []) candidates.push(`${stem}${substitute}`);
  }
  return [...new Set(candidates)].filter(isSupportedSourcePath);
}

export function createSourceResolverIndex(
  context: SourceResolverContext,
): SourceResolverIndex {
  const sourcePaths = new Set<string>();
  for (const file of context.files) {
    const kind = file.kind;
    const path = file.path;
    if (kind === "file" && isSupportedSourcePath(path)) sourcePaths.add(path);
  }
  const projectsByPackageName = new Map<string, DetectedProject[]>();
  for (const project of context.projects) {
    if (project.packageName === undefined) continue;
    const projects = projectsByPackageName.get(project.packageName) ?? [];
    projects.push(project);
    projectsByPackageName.set(project.packageName, projects);
  }
  for (const projects of projectsByPackageName.values()) {
    projects.sort((left, right) => left.id.localeCompare(right.id));
  }
  const manifestByProjectId = new Map<
    string,
    Extract<ManifestRecord, { status: "valid" }>
  >();
  for (const project of context.projects) {
    const manifest = context.manifests.find((entry): entry is Extract<ManifestRecord, { status: "valid" }> =>
      entry.status === "valid" && project.manifestPaths.includes(entry.path)
    );
    if (manifest !== undefined) manifestByProjectId.set(project.id, manifest);
  }
  return {
    ...context,
    sourcePaths,
    projectsByPackageName,
    manifestByProjectId,
  };
}

function relativeTargetLimitation(
  importerPath: string,
  disposition: MissingTargetDisposition,
): string {
  if (disposition === "declared-publication-output") {
    return `${importerPath}: relative source target is declared publication output and may require generation.`;
  }
  if (disposition === "literal-ignored-output") {
    return `${importerPath}: relative source target is covered by a literal ignore rule and may be generated.`;
  }
  if (disposition === "fixture-controlled") {
    return `${importerPath}: relative source target is fixture-controlled.`;
  }
  return `${importerPath}: relative source target was not found in the current inventory.`;
}

function resolveCandidates(
  candidates: readonly string[],
  sourcePaths: ReadonlySet<string>,
): { targetPath: string; targetExists: boolean } | undefined {
  const existing = candidates.find((candidate) => sourcePaths.has(candidate));
  if (existing !== undefined) return { targetPath: existing, targetExists: true };
  const first = candidates[0];
  return first === undefined ? undefined : { targetPath: first, targetExists: false };
}

function isExplicitSupportedTarget(value: string): boolean {
  return isSupportedSourcePath(value.replace("*", "__codebase_doctor_wildcard__"));
}

function aliasMatch(alias: SafeSourceAlias, specifier: string): string | undefined {
  const pattern = aliasPattern(alias);
  if (pattern === undefined) return undefined;
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function resolveAlias(
  importerPath: string,
  specifier: string,
  context: SourceResolverContext,
  sourcePaths: ReadonlySet<string>,
): SourceResolution | undefined {
  const config = sourceConfigForPath(context.configs, importerPath);
  if (config === undefined) return undefined;
  for (const alias of config.aliases) {
    const replacement = aliasMatch(alias, specifier);
    if (replacement === undefined) continue;
    const targetCandidates = aliasTargets(alias).flatMap((target) =>
      candidatePaths(config.basePath, target.replace("*", replacement), importerPath) ?? []
    );
    const existing = [...new Set(targetCandidates.filter((path) => sourcePaths.has(path)))];
    if (existing.length > 1) {
      return {
        kind: "unsupported",
        limitations: [`${importerPath}: source alias resolves ambiguously.`],
      };
    }
    if (existing.length === 1) {
      return {
        kind: "internal",
        targetPath: existing[0]!,
        targetExists: true,
        limitations: [],
      };
    }
    const first = targetCandidates[0];
    if (first !== undefined && aliasTargets(alias).length === 1) {
      const target = aliasTargets(alias)[0];
      return {
        kind: "internal",
        targetPath: first,
        targetExists: false,
        ...(target !== undefined && isExplicitSupportedTarget(target)
          ? { missingTargetProof: "alias-explicit" as const }
          : {}),
        limitations: [`${importerPath}: source alias target was not found in the current inventory.`],
      };
    }
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: source alias resolves ambiguously.`],
    };
  }
  return undefined;
}

function packageIdentity(specifier: string): { name: string; subpath: string } | undefined {
  if (!/^(?:@[^/]+\/[^/]+|[^@./][^/]*)/.test(specifier)) return undefined;
  const parts = specifier.split("/");
  const nameParts = specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
  if (nameParts.some((part) => part.length === 0)) return undefined;
  return {
    name: nameParts.join("/"),
    subpath: parts.slice(nameParts.length).join("/"),
  };
}

function stringEntry(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function workspaceEntry(
  manifest: Extract<ManifestRecord, { status: "valid" }> | undefined,
  subpath: string,
  typeOnly: boolean,
): { entry?: string; unsupported: boolean; explicit: boolean } {
  const data = manifest?.data ?? {};
  if (subpath.length > 0) {
    const exports = objectValue(data.exports);
    if (exports !== undefined) {
      const exported = exports[`./${subpath}`];
      return typeof exported === "string"
        ? { entry: exported, unsupported: false, explicit: true }
        : { unsupported: true, explicit: false };
    }
    return { entry: subpath, unsupported: false, explicit: false };
  }
  if (typeOnly && typeof data.types === "string") {
    return { entry: data.types, unsupported: false, explicit: true };
  }
  if (data.exports !== undefined) {
    if (typeof data.exports === "string") {
      return { entry: data.exports, unsupported: false, explicit: true };
    }
    const exports = objectValue(data.exports);
    if (exports !== undefined && typeof exports["."] === "string") {
      return { entry: exports["."] as string, unsupported: false, explicit: true };
    }
    return { unsupported: true, explicit: false };
  }
  const explicitEntry = stringEntry(data.module) ?? stringEntry(data.main);
  return {
    entry: explicitEntry ?? "index",
    unsupported: false,
    explicit: explicitEntry !== undefined,
  };
}

function resolveWorkspace(
  importerPath: string,
  specifier: string,
  reference: SafeImportReference,
  context: SourceResolverIndex,
  sourcePaths: ReadonlySet<string>,
): SourceResolution | undefined {
  const identity = packageIdentity(specifier);
  if (identity === undefined) return undefined;
  const projects = context.projectsByPackageName.get(identity.name) ?? [];
  if (projects.length === 0) return undefined;
  if (projects.length > 1) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: internal workspace package identity is ambiguous.`],
    };
  }
  const project = projects[0]!;
  const entry = workspaceEntry(
    context.manifestByProjectId.get(project.id),
    identity.subpath,
    reference.kind === "type-only",
  );
  if (entry.unsupported || entry.entry === undefined) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: workspace package entry point is unsupported or ambiguous.`],
    };
  }
  const candidates = candidatePaths(project.root, entry.entry, importerPath);
  if (candidates === undefined) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: workspace package entry point is unsupported or unsafe.`],
    };
  }
  const resolved = resolveCandidates(candidates, sourcePaths);
  if (resolved === undefined) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: workspace package entry point is unsupported or ambiguous.`],
    };
  }
  return {
    kind: "internal",
    ...resolved,
    limitations: resolved.targetExists
      ? []
      : [entry.explicit
          ? `${importerPath}: workspace publication target was not found in the current inventory; the entry may require a build.`
          : `${importerPath}: workspace source target was not found in the current inventory.`],
  };
}

export function resolveSourceImport(
  importerPath: string,
  reference: SafeImportReference,
  context: SourceResolverContext | SourceResolverIndex,
): SourceResolution {
  const index = "sourcePaths" in context ? context : createSourceResolverIndex(context);
  const specifier = importSpecifier(reference);
  if (specifier === undefined) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: source import value is unavailable.`],
    };
  }
  const sourcePaths = index.sourcePaths;
  if (specifier.startsWith(".")) {
    const candidates = candidatePaths(posix.dirname(importerPath), specifier, importerPath);
    if (candidates === undefined) {
      return {
        kind: "unsupported",
        limitations: [`${importerPath}: source import escapes the repository.`],
      };
    }
    const resolved = resolveCandidates(candidates, sourcePaths);
    if (resolved === undefined) {
      return {
        kind: "unsupported",
        limitations: [`${importerPath}: relative source target is unsupported.`],
      };
    }
    const disposition = resolved.targetExists || !isExplicitSupportedTarget(specifier)
      ? "provable"
      : classifyMissingRelativeTarget(
          importerPath,
          resolved.targetPath,
          index.manifests,
          index.generatedTargetEvidence ?? { literalIgnoredPrefixes: [] },
        );
    return {
      kind: "internal",
      ...resolved,
      ...(!resolved.targetExists && isExplicitSupportedTarget(specifier) && disposition === "provable"
        ? { missingTargetProof: "relative-explicit" as const }
        : {}),
      limitations: resolved.targetExists
        ? []
        : [relativeTargetLimitation(importerPath, disposition)],
    };
  }
  if (specifier.startsWith("/") || specifier.includes("\0")) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: source import escapes the repository.`],
    };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return { kind: "external", limitations: [] };
  }

  const alias = resolveAlias(importerPath, specifier, index, sourcePaths);
  if (alias !== undefined) return alias;
  const workspace = resolveWorkspace(importerPath, specifier, reference, index, sourcePaths);
  if (workspace !== undefined) return workspace;
  return { kind: "external", limitations: [] };
}
