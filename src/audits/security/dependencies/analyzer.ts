import { posix } from "node:path";
import type { ManifestRecord } from "../../../workspace/types.js";
import {
  dependencySpecMatches,
  type NpmLockGraph,
  type NpmLockParseResult,
  type SafeNpmLockEntry,
} from "./parser.js";
import type { DependencyAuditTarget } from "./selection.js";
import { classifyDependencySource, safeNpmPackageName } from "./source.js";
import {
  DEPENDENCY_SECTIONS,
  type DependencyMatch,
  type DependencySection,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export interface InternalPackage {
  readonly name: string;
  readonly root: string;
}

export interface DependencyAnalysisInput {
  readonly target: DependencyAuditTarget;
  readonly manifests: readonly ManifestRecord[];
  readonly lock?: NpmLockParseResult;
  readonly internalPackages: readonly InternalPackage[];
}

export interface DependencyAnalysisResult {
  readonly matches: readonly DependencyMatch[];
  readonly limitations: readonly string[];
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function manifestSections(
  manifest: Extract<ManifestRecord, { status: "valid" }>,
  limitations: Set<string>,
): Record<DependencySection, Map<string, string>> {
  const sections: Record<DependencySection, Map<string, string>> = {
    dependencies: new Map(),
    devDependencies: new Map(),
    optionalDependencies: new Map(),
    peerDependencies: new Map(),
  };
  for (const section of DEPENDENCY_SECTIONS) {
    if (manifest.data[section] === undefined) continue;
    const entries = objectValue(manifest.data[section]);
    if (entries === undefined) {
      limitations.add(`${manifest.path}: invalid dependency section limits dependency analysis.`);
      continue;
    }
    for (const name of Object.keys(entries).sort()) {
      const packageName = safeNpmPackageName(name);
      const spec = entries[name];
      if (packageName === undefined || typeof spec !== "string") {
        limitations.add(`${manifest.path}: invalid dependency entry limits dependency analysis.`);
        continue;
      }
      sections[section].set(packageName, spec);
    }
  }
  return sections;
}

function lockEntryPath(lockRoot: string, projectRoot: string): string {
  if (lockRoot === projectRoot) return "";
  const base = lockRoot === "." ? "." : lockRoot;
  return posix.relative(base, projectRoot);
}

function driftMatch(
  path: string,
  packageName: string,
  section: DependencySection,
): DependencyMatch {
  return {
    family: "manifest-lock-drift",
    path,
    packageName,
    section,
    severity: "medium",
    confidence: "high",
  };
}

function hasExternalInstallGraph(
  sections: Readonly<Record<DependencySection, ReadonlyMap<string, string>>>,
  internalNames: ReadonlySet<string>,
): boolean {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const [name, spec] of sections[section]) {
      if (internalNames.has(name)) continue;
      const source = classifyDependencySource(spec).sourceClass;
      if (source !== "local-file" && source !== "local-link" && source !== "workspace") {
        return true;
      }
    }
  }
  return false;
}

function analyzeDrift(
  graph: NpmLockGraph,
  entry: SafeNpmLockEntry | undefined,
  entryPath: string,
  manifestPath: string,
  sections: Readonly<Record<DependencySection, ReadonlyMap<string, string>>>,
): DependencyMatch[] {
  const matches: DependencyMatch[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const manifestNames = new Set(sections[section].keys());
    const lockNames = new Set(entry?.sections[section] ?? []);
    const names = [...new Set([...manifestNames, ...lockNames])].sort();
    for (const name of names) {
      const manifestSpec = sections[section].get(name);
      if (
        manifestSpec === undefined ||
        !lockNames.has(name) ||
        !dependencySpecMatches(graph, entryPath, section, name, manifestSpec)
      ) {
        matches.push(driftMatch(manifestPath, name, section));
      }
    }
  }
  return matches;
}

function installedEntry(
  graph: NpmLockGraph,
  packageName: string,
): SafeNpmLockEntry | undefined {
  return graph.entries
    .filter((entry) => entry.packageName === packageName)
    .sort((left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path))[0];
}

function sourceMatches(
  manifestPath: string,
  sections: Readonly<Record<DependencySection, ReadonlyMap<string, string>>>,
  graph: NpmLockGraph | undefined,
): DependencyMatch[] {
  const matches: DependencyMatch[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [packageName, spec] of sections[section]) {
      const source = classifyDependencySource(spec);
      if (source.sourceClass === "insecure-http" || source.sourceClass === "insecure-git") {
        matches.push({
          family: "insecure-source",
          path: manifestPath,
          packageName,
          section,
          sourceClass: source.sourceClass,
          severity: "high",
          confidence: "high",
        });
      }
      if (
        source.sourceClass === "git-mutable" &&
        installedEntry(graph ?? { entries: [] }, packageName)?.gitPinned !== true
      ) {
        matches.push({
          family: "mutable-git-source",
          path: manifestPath,
          packageName,
          section,
          sourceClass: "git-mutable",
          severity: "medium",
          confidence: "high",
        });
      }
    }
  }
  return matches;
}

function lockEvidenceMatches(
  graph: NpmLockGraph,
  lockPath: string,
): DependencyMatch[] {
  const matches: DependencyMatch[] = [];
  for (const entry of graph.entries) {
    if (
      entry.sourceClass === "insecure-http" ||
      entry.sourceClass === "insecure-git"
    ) {
      matches.push({
        family: "insecure-source",
        path: lockPath,
        ...(entry.packageName === undefined ? {} : { packageName: entry.packageName }),
        sourceClass: entry.sourceClass,
        severity: "high",
        confidence: "high",
      });
    }
    if (entry.integrity === "missing" || entry.integrity === "invalid") {
      matches.push({
        family: "missing-integrity",
        path: lockPath,
        ...(entry.packageName === undefined ? {} : { packageName: entry.packageName }),
        sourceClass: entry.sourceClass,
        severity: "medium",
        confidence: "high",
      });
    }
  }
  return matches;
}

function workspaceResolutionMatches(
  target: DependencyAuditTarget,
  graph: NpmLockGraph,
  manifestPath: string,
  sections: Readonly<Record<DependencySection, ReadonlyMap<string, string>>>,
  internalPackages: readonly InternalPackage[],
): DependencyMatch[] {
  const internalByName = new Map(internalPackages.map((entry) => [entry.name, entry]));
  const matches: DependencyMatch[] = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const packageName of sections[section].keys()) {
      const internal = internalByName.get(packageName);
      if (internal === undefined) continue;
      const entry = installedEntry(graph, packageName);
      if (entry === undefined) continue;
      const base = target.lockRoot === "." ? "." : target.lockRoot;
      const expectedPath = posix.relative(base, internal.root);
      if (entry.link !== true || entry.resolvedWorkspacePath !== expectedPath) {
        matches.push({
          family: "workspace-registry-resolution",
          path: manifestPath,
          packageName,
          section,
          severity: "high",
          confidence: "high",
        });
      }
    }
  }
  return matches;
}

function compareMatches(left: DependencyMatch, right: DependencyMatch): number {
  return left.path.localeCompare(right.path) ||
    left.family.localeCompare(right.family) ||
    (left.section ?? "").localeCompare(right.section ?? "") ||
    (left.packageName ?? "").localeCompare(right.packageName ?? "") ||
    (left.sourceClass ?? "").localeCompare(right.sourceClass ?? "");
}

export function analyzeDependencyTarget(
  input: DependencyAnalysisInput,
): DependencyAnalysisResult {
  const { target } = input;
  const limitations = new Set<string>();
  const matches: DependencyMatch[] = target.competingLockfilePaths.map((path) => ({
    family: "competing-npm-lockfiles",
    path,
    severity: "low",
    confidence: "high",
  }));
  const manifestByPath = new Map(input.manifests.map((entry) => [entry.path, entry]));
  const internalNames = new Set(input.internalPackages.map(({ name }) => name));

  let supportedGraph: NpmLockGraph | undefined;
  if (target.authority !== "none") {
    if (input.lock === undefined) {
      if (target.lockfile !== undefined) {
        limitations.add(`${target.lockfile.path}: selected npm lockfile was not parsed.`);
      }
    } else if (input.lock.status === "supported") {
      supportedGraph = input.lock.graph;
      for (const limitation of input.lock.limitations) {
        limitations.add(`${target.lockfile?.path ?? "npm lockfile"}: ${limitation}`);
      }
    } else {
      for (const limitation of input.lock.limitations) {
        limitations.add(`${target.lockfile?.path ?? "npm lockfile"}: ${limitation}`);
      }
    }
  }

  for (const project of target.coveredProjects) {
    if (project.manifestPath === undefined) {
      limitations.add(`${project.root}: package manifest path is unavailable.`);
      continue;
    }
    const manifest = manifestByPath.get(project.manifestPath);
    if (manifest === undefined || manifest.status === "invalid") {
      limitations.add(`${project.manifestPath}: valid package manifest is unavailable.`);
      continue;
    }
    const sections = manifestSections(manifest, limitations);
    matches.push(...sourceMatches(manifest.path, sections, supportedGraph));
    if (target.authority === "none") {
      if (
        target.lockOwnership === "explicit-standalone" &&
        hasExternalInstallGraph(sections, internalNames)
      ) {
        matches.push({
          family: "missing-lockfile",
          path: manifest.path,
          severity: "medium",
          confidence: "high",
        });
      }
      continue;
    }
    if (supportedGraph === undefined) continue;
    const entryPath = lockEntryPath(target.lockRoot, project.root);
    const entry = supportedGraph.entries.find(({ path }) => path === entryPath);
    matches.push(...analyzeDrift(supportedGraph, entry, entryPath, manifest.path, sections));
    matches.push(...workspaceResolutionMatches(
      target,
      supportedGraph,
      manifest.path,
      sections,
      input.internalPackages,
    ));
  }

  if (supportedGraph !== undefined) {
    matches.push(...lockEvidenceMatches(
      supportedGraph,
      target.lockfile?.path ?? "npm lockfile",
    ));
  }

  return {
    matches: matches.sort(compareMatches),
    limitations: [...limitations].sort(),
  };
}
