import { posix } from "node:path";
import type {
  FileInventory,
  ManifestRecord,
} from "../workspace/types.js";

export interface GeneratedTargetEvidence {
  readonly literalIgnoredPrefixes: readonly string[];
}

export type MissingTargetDisposition =
  | "provable"
  | "declared-publication-output"
  | "literal-ignored-output"
  | "fixture-controlled";

export interface GeneratedTargetEvidenceResult {
  readonly evidence: GeneratedTargetEvidence;
  readonly limitations: readonly string[];
}

const MAX_IGNORE_BYTES = 128 * 1024;
const FIXTURE_SEGMENTS = new Set([
  "fixture",
  "fixtures",
  "__fixtures__",
  "__testfixtures__",
]);

function safeRepositoryPath(base: string, value: string): string | undefined {
  if (value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) return undefined;
  if (value.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  const normalized = posix.normalize(posix.join(base === "." ? "" : base, value));
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized === "." ? undefined : normalized;
}

function safeIgnorePrefix(ignorePath: string, rawLine: string): string | undefined {
  if (rawLine !== rawLine.trimStart()) return undefined;
  const line = rawLine.trimEnd();
  if (
    line.length === 0 ||
    line.startsWith("#") ||
    line.startsWith("!") ||
    line.includes("\\") ||
    /[?[\]{}]/.test(line)
  ) return undefined;

  let pattern = line.startsWith("/") ? line.slice(1) : line;
  const wildcardMatches = pattern.match(/\*/g)?.length ?? 0;
  if (pattern.endsWith("/**")) pattern = pattern.slice(0, -3);
  else if (pattern.endsWith("/*")) pattern = pattern.slice(0, -2);
  else if (wildcardMatches > 0) return undefined;
  if ((pattern.match(/\*/g)?.length ?? 0) > 0) return undefined;
  pattern = pattern.replace(/\/+$/, "");
  if (pattern.length === 0) return undefined;

  return safeRepositoryPath(posix.dirname(ignorePath), pattern);
}

export async function loadGeneratedTargetEvidence(
  inventory: FileInventory,
  readFile: (path: string) => Promise<string>,
): Promise<GeneratedTargetEvidenceResult> {
  const prefixes = new Set<string>();
  const limitations = new Set<string>();
  const ignoreFiles = inventory.files
    .filter(({ kind, path }) => kind === "file" && posix.basename(path) === ".gitignore")
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const file of ignoreFiles) {
    if (file.size > MAX_IGNORE_BYTES) {
      limitations.add(`${file.path}: ignore evidence exceeds the ${MAX_IGNORE_BYTES}-byte limit.`);
      continue;
    }
    let contents: string;
    try {
      contents = await readFile(file.path);
    } catch {
      limitations.add(`${file.path}: ignore evidence could not be read.`);
      continue;
    }
    if (Buffer.byteLength(contents, "utf8") > MAX_IGNORE_BYTES) {
      limitations.add(`${file.path}: ignore evidence exceeds the ${MAX_IGNORE_BYTES}-byte limit after reading.`);
      continue;
    }
    for (const line of contents.split(/\r?\n/u)) {
      const prefix = safeIgnorePrefix(file.path, line);
      if (prefix !== undefined) prefixes.add(prefix);
    }
  }

  return {
    evidence: { literalIgnoredPrefixes: [...prefixes].sort() },
    limitations: [...limitations].sort(),
  };
}

function containsPath(root: string, path: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function validManifestRoot(
  manifest: ManifestRecord,
  importerPath: string,
): string | undefined {
  if (manifest.status !== "valid") return undefined;
  const root = posix.dirname(manifest.path);
  return containsPath(root, importerPath) ? root : undefined;
}

function safePublicationEntry(value: unknown): { path: string; prefix: boolean } | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) return undefined;
  let entry = value.startsWith("./") ? value.slice(2) : value;
  let prefix = false;
  if (entry.endsWith("/**")) {
    entry = entry.slice(0, -3);
    prefix = true;
  } else if (entry.endsWith("/")) {
    entry = entry.slice(0, -1);
    prefix = true;
  }
  if (entry.length === 0 || entry.includes("*") || /[?[\]{}]/.test(entry)) return undefined;
  const normalized = safeRepositoryPath(".", entry);
  return normalized === undefined
    ? undefined
    : { path: normalized, prefix: prefix || posix.extname(normalized).length === 0 };
}

function publicationOutput(
  importerPath: string,
  targetPath: string,
  manifests: readonly ManifestRecord[],
): boolean {
  const nearest = manifests
    .map((manifest) => ({ manifest, root: validManifestRoot(manifest, importerPath) }))
    .filter((entry): entry is { manifest: Extract<ManifestRecord, { status: "valid" }>; root: string } =>
      entry.root !== undefined && entry.manifest.status === "valid"
    )
    .sort((left, right) =>
      right.root.split("/").length - left.root.split("/").length ||
      left.manifest.path.localeCompare(right.manifest.path)
    )[0];
  if (nearest === undefined || !Array.isArray(nearest.manifest.data.files)) return false;

  const roots = [nearest.root];
  const relativeImporter = posix.relative(nearest.root === "." ? "" : nearest.root, importerPath);
  if (relativeImporter === "npm" || relativeImporter.startsWith("npm/")) {
    roots.push(nearest.root === "." ? "npm" : `${nearest.root}/npm`);
  }

  for (const rawEntry of nearest.manifest.data.files) {
    const entry = safePublicationEntry(rawEntry);
    if (entry === undefined) continue;
    for (const root of roots) {
      const candidate = safeRepositoryPath(root, entry.path);
      if (candidate === undefined) continue;
      if (targetPath === candidate || (entry.prefix && targetPath.startsWith(`${candidate}/`))) {
        return true;
      }
    }
  }
  return false;
}

function underLiteralPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function fixtureControlled(...paths: readonly string[]): boolean {
  return paths.some((path) => path.split("/").some((segment) => FIXTURE_SEGMENTS.has(segment)));
}

export function classifyMissingRelativeTarget(
  importerPath: string,
  targetPath: string,
  manifests: readonly ManifestRecord[],
  evidence: GeneratedTargetEvidence,
): MissingTargetDisposition {
  if (publicationOutput(importerPath, targetPath, manifests)) {
    return "declared-publication-output";
  }
  if (underLiteralPrefix(targetPath, evidence.literalIgnoredPrefixes)) {
    return "literal-ignored-output";
  }
  if (fixtureControlled(importerPath, targetPath)) return "fixture-controlled";
  return "provable";
}
