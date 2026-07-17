import { posix } from "node:path";
import { classifyDependencySource, safeNpmPackageName } from "./source.js";
import {
  DEPENDENCY_SECTIONS,
  type DependencySection,
  type SafeSourceClass,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export type IntegrityStatus = "valid" | "missing" | "invalid" | "not-required";

export interface SafeNpmLockEntry {
  readonly path: string;
  readonly packageName?: string;
  readonly link: boolean;
  readonly resolvedWorkspacePath?: string;
  readonly sourceClass: SafeSourceClass;
  readonly gitPinned: boolean;
  readonly tarball: boolean;
  readonly integrity: IntegrityStatus;
  readonly sections: Readonly<Record<DependencySection, readonly string[]>>;
}

export interface NpmLockGraph {
  readonly entries: readonly SafeNpmLockEntry[];
}

export type NpmLockParseResult =
  | {
      readonly status: "supported";
      readonly version: 2 | 3;
      readonly graph: NpmLockGraph;
      readonly limitations: readonly string[];
    }
  | {
      readonly status: "unsupported" | "invalid";
      readonly limitations: readonly string[];
    };

type RawSectionSpecs = Readonly<Record<DependencySection, ReadonlyMap<string, string>>>;
const rawSpecsByGraph = new WeakMap<NpmLockGraph, ReadonlyMap<string, RawSectionSpecs>>();

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function safeRepositoryPath(value: string): string | undefined {
  if (value.length === 0) return "";
  if (value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) return undefined;
  if (value.split("/").includes("..")) return undefined;
  const normalized = posix.normalize(value);
  return normalized === value && normalized !== "." ? value : undefined;
}

function packageNameFromPath(path: string): string | undefined {
  const segments = path.split("/");
  const marker = segments.lastIndexOf("node_modules");
  if (marker < 0) return undefined;
  const first = segments[marker + 1];
  if (first === undefined) return undefined;
  const candidate = first.startsWith("@")
    ? `${first}/${segments[marker + 2] ?? ""}`
    : first;
  return safeNpmPackageName(candidate);
}

function emptySections(): Record<DependencySection, string[]> {
  return {
    dependencies: [],
    devDependencies: [],
    optionalDependencies: [],
    peerDependencies: [],
  };
}

function emptyRawSections(): Record<DependencySection, Map<string, string>> {
  return {
    dependencies: new Map(),
    devDependencies: new Map(),
    optionalDependencies: new Map(),
    peerDependencies: new Map(),
  };
}

function validIntegrity(value: string): boolean {
  const tokens = value.trim().split(/\s+/u);
  return tokens.length > 0 && tokens.every((token) =>
    /^(?:sha1|sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}(?:\?[^\s]+)?$/u.test(token)
  );
}

function integrityStatus(
  path: string,
  link: boolean,
  sourceClass: SafeSourceClass,
  tarball: boolean,
  value: unknown,
): IntegrityStatus {
  if (
    link ||
    !path.split("/").includes("node_modules") ||
    sourceClass !== "secure-https" ||
    !tarball
  ) {
    return "not-required";
  }
  if (value === undefined) return "missing";
  return typeof value === "string" && validIntegrity(value) ? "valid" : "invalid";
}

export function parseNpmLock(content: string): NpmLockParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    return { status: "invalid", limitations: ["Selected npm lockfile is not valid JSON."] };
  }
  const root = objectValue(decoded);
  if (root === undefined) {
    return {
      status: "invalid",
      limitations: ["Selected npm lockfile must contain a JSON object."],
    };
  }
  const version = root.lockfileVersion;
  if (version !== 2 && version !== 3) {
    return {
      status: "unsupported",
      limitations: ["Selected npm lockfile version is unsupported."],
    };
  }
  const packages = objectValue(root.packages);
  if (packages === undefined) {
    return {
      status: "invalid",
      limitations: ["Selected npm lockfile has no packages object."],
    };
  }

  const limitations = new Set<string>();
  const entries: SafeNpmLockEntry[] = [];
  const graphRawSpecs = new Map<string, RawSectionSpecs>();
  for (const path of Object.keys(packages).sort()) {
    if (safeRepositoryPath(path) === undefined) {
      limitations.add("Selected npm lockfile contains an unsafe package path.");
      continue;
    }
    const rawEntry = objectValue(packages[path]);
    if (rawEntry === undefined) {
      return {
        status: "invalid",
        limitations: ["Selected npm lockfile contains an invalid package entry."],
      };
    }
    const sections = emptySections();
    const rawSections = emptyRawSections();
    for (const section of DEPENDENCY_SECTIONS) {
      if (rawEntry[section] === undefined) continue;
      const values = objectValue(rawEntry[section]);
      if (values === undefined) {
        limitations.add("Selected npm lockfile contains an invalid dependency section.");
        continue;
      }
      for (const name of Object.keys(values).sort()) {
        const spec = values[name];
        const safeName = safeNpmPackageName(name);
        if (safeName === undefined || typeof spec !== "string") {
          limitations.add("Selected npm lockfile contains an invalid dependency entry.");
          continue;
        }
        sections[section].push(safeName);
        rawSections[section].set(safeName, spec);
      }
    }

    const link = rawEntry.link === true;
    const rawResolved = typeof rawEntry.resolved === "string" ? rawEntry.resolved : undefined;
    if (rawEntry.resolved !== undefined && rawResolved === undefined) {
      limitations.add("Selected npm lockfile contains an invalid resolved source.");
    }
    const source = classifyDependencySource(rawResolved ?? "");
    const packageName = packageNameFromPath(path);
    const tarball = rawResolved !== undefined && /^https:\/\/[^\s?#]+\.tgz(?:[?#]|$)/iu.test(rawResolved);
    const resolvedWorkspacePath = link && rawResolved !== undefined
      ? safeRepositoryPath(rawResolved)
      : undefined;
    if (link && rawResolved !== undefined && resolvedWorkspacePath === undefined) {
      limitations.add("Selected npm lockfile contains an unsafe workspace link path.");
    }
    entries.push({
      path,
      ...(packageName === undefined ? {} : { packageName }),
      link,
      ...(resolvedWorkspacePath === undefined ? {} : { resolvedWorkspacePath }),
      sourceClass: source.sourceClass,
      gitPinned: source.gitPinned,
      tarball,
      integrity: integrityStatus(path, link, source.sourceClass, tarball, rawEntry.integrity),
      sections,
    });
    graphRawSpecs.set(path, rawSections);
  }

  const graph: NpmLockGraph = { entries };
  rawSpecsByGraph.set(graph, graphRawSpecs);
  return {
    status: "supported",
    version,
    graph,
    limitations: [...limitations].sort(),
  };
}

export function dependencySpecMatches(
  graph: NpmLockGraph,
  entryPath: string,
  section: DependencySection,
  packageName: string,
  expected: string,
): boolean {
  return rawSpecsByGraph.get(graph)?.get(entryPath)?.[section].get(packageName) === expected;
}
