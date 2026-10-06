import { posix } from "node:path";
import type {
  DetectedProject,
  FileRecord,
  ProjectSnapshot,
} from "../../../workspace/types.js";
import { classifyDependencySource } from "./source.js";
import type { DependencyMatch, SafeSourceClass } from "./types.js";

export type PythonLockManager = "poetry" | "uv";

const PYTHON_LOCKS: readonly { readonly basename: string; readonly manager: PythonLockManager }[] = [
  { basename: "poetry.lock", manager: "poetry" },
  { basename: "uv.lock", manager: "uv" },
];

const FULL_SHA = /^[0-9a-f]{40}$/iu;

export interface PythonProject {
  readonly projectId: string;
  readonly root: string;
  readonly manifestPath?: string;
}

export interface PythonAuditTarget {
  readonly lockRoot: string;
  readonly manager: PythonLockManager;
  readonly lockfile?: FileRecord;
  readonly coveredProjects: readonly PythonProject[];
  readonly competingLockfilePaths: readonly string[];
  readonly limitations: readonly string[];
  readonly scope: "full" | "changed";
}

export interface PythonSelection {
  readonly targets: readonly PythonAuditTarget[];
  readonly handledProjectIds: ReadonlySet<string>;
  readonly limitations: readonly string[];
}

function pathAtRoot(root: string, basename: string): string {
  return root === "." ? basename : `${root}/${basename}`;
}

function isPythonProject(project: DetectedProject): boolean {
  return project.ecosystems.some((ecosystem) => ecosystem.toLowerCase() === "python");
}

function manifestPathFor(project: DetectedProject): string | undefined {
  const expected = pathAtRoot(project.root, "pyproject.toml");
  if (project.manifestPaths.includes(expected)) return expected;
  return [...project.manifestPaths].sort().find((path) => posix.basename(path) === "pyproject.toml");
}

function containsRoot(owner: DetectedProject, project: DetectedProject): boolean {
  return owner.root === "." ||
    project.root === owner.root ||
    project.root.startsWith(`${owner.root}/`);
}

/**
 * Selects Python projects governed by a poetry or uv lockfile, or carrying a
 * `pyproject.toml` manifest. Projects with neither keep today's unsupported
 * coverage; setup.py/setup.cfg/requirements-only layouts are not promoted.
 */
export function selectPythonTargets(snapshot: ProjectSnapshot): PythonSelection {
  const scope = snapshot.auditScope.mode;
  const filesByPath = new Map(snapshot.files.map((entry) => [entry.path, entry]));
  const affected = new Set(snapshot.auditScope.affectedProjectIds);
  const limitations = new Set<string>();

  const selectedProjects = snapshot.projects
    .filter((project) => scope === "full" || affected.has(project.id))
    .filter(isPythonProject)
    .sort((left, right) => left.root.localeCompare(right.root));

  function lockAt(root: string): { path: string; manager: PythonLockManager; record: FileRecord } | undefined {
    const present = PYTHON_LOCKS
      .map(({ basename, manager }) => {
        const record = filesByPath.get(pathAtRoot(root, basename));
        return record?.kind === "file" ? { path: record.path, manager, record } : undefined;
      })
      .filter((entry): entry is { path: string; manager: PythonLockManager; record: FileRecord } =>
        entry !== undefined
      );
    if (present.length > 1) return undefined;
    return present[0];
  }

  function governingRoot(project: DetectedProject): string {
    if (lockAt(project.root) !== undefined) return project.root;
    const ancestors = snapshot.projects
      .filter((candidate) => candidate.id !== project.id && containsRoot(candidate, project))
      .sort((left, right) =>
        right.root.split("/").length - left.root.split("/").length ||
        left.root.localeCompare(right.root)
      );
    return ancestors.find((candidate) => lockAt(candidate.root) !== undefined)?.root ?? project.root;
  }

  const byRoot = new Map<string, DetectedProject[]>();
  for (const project of selectedProjects) {
    const manifest = manifestPathFor(project);
    const root = governingRoot(project);
    // Without a lockfile or a pyproject manifest there is nothing checkable;
    // the project keeps its existing unsupported coverage.
    if (lockAt(root) === undefined && manifest === undefined) continue;
    const grouped = byRoot.get(root) ?? [];
    grouped.push(project);
    byRoot.set(root, grouped);
  }

  const targets: PythonAuditTarget[] = [];
  const handledProjectIds = new Set<string>();
  for (const [lockRoot, projects] of [...byRoot.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const present = PYTHON_LOCKS
      .map(({ basename, manager }) => {
        const record = filesByPath.get(pathAtRoot(lockRoot, basename));
        return record?.kind === "file" ? { path: record.path, manager, record } : undefined;
      })
      .filter((entry): entry is { path: string; manager: PythonLockManager; record: FileRecord } =>
        entry !== undefined
      );
    const targetLimitations: string[] = [];
    let chosen = present.length === 1 ? present[0] : undefined;
    if (present.length > 1) {
      targetLimitations.push(
        `${lockRoot}: multiple Python lockfiles are present; drift claims were withheld.`,
      );
      chosen = undefined;
    }
    if (chosen === undefined && present.length === 0) {
      // Manifest-only target: missing-lockfile analysis still applies.
    } else if (chosen === undefined) {
      for (const project of projects) handledProjectIds.add(project.id);
      limitations.add(
        `${lockRoot}: multiple Python lockfiles are present without a governing choice; lock analysis was withheld.`,
      );
      continue;
    }
    const manager = chosen?.manager ?? "poetry";
    const competing = present
      .filter((entry) => entry.path !== chosen?.path)
      .map((entry) => entry.path)
      .sort();
    targets.push({
      lockRoot,
      manager,
      ...(chosen === undefined ? {} : { lockfile: chosen.record }),
      coveredProjects: projects
        .sort((left, right) => left.root.localeCompare(right.root))
        .map((project) => ({
          projectId: project.id,
          root: project.root,
          ...(manifestPathFor(project) === undefined
            ? {}
            : { manifestPath: manifestPathFor(project) as string }),
        })),
      competingLockfilePaths: competing,
      limitations: targetLimitations,
      scope,
    });
    for (const project of projects) handledProjectIds.add(project.id);
  }

  for (const change of snapshot.auditScope.changes) {
    if (
      change.status === "deleted" &&
      PYTHON_LOCKS.some(({ basename }) => posix.basename(change.path) === basename)
    ) {
      limitations.add(`${change.path}: deleted dependency metadata could not be examined.`);
    }
  }

  return {
    targets: targets.sort((left, right) => left.lockRoot.localeCompare(right.lockRoot)),
    handledProjectIds,
    limitations: [...limitations].sort(),
  };
}

export interface PythonLockedPackage {
  readonly name: string;
  readonly version: string;
  readonly source: "registry" | "git" | "other";
  readonly url?: string;
  readonly reference?: string;
  readonly resolvedReference?: string;
  readonly integrity: boolean;
}

export interface PythonLockSummary {
  readonly manager: PythonLockManager;
  readonly path: string;
  readonly packages: readonly PythonLockedPackage[];
  readonly limitations: readonly string[];
}

function pep503Name(value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/[-_.]+/gu, "-");
  return /^[a-z0-9]([a-z0-9-]{0,99})$/u.test(normalized) ? normalized : undefined;
}

function pep440Version(value: string): string | undefined {
  return /^\d+(?:\.\d+)*(?:[A-Za-z0-9.+-]*)$/u.test(value) ? value : undefined;
}

interface MutablePythonPackage {
  name?: string;
  version?: string;
  source: "registry" | "git" | "other";
  url?: string;
  reference?: string;
  resolvedReference?: string;
  integrity: boolean;
  inSource: boolean;
}

/**
 * Parses poetry.lock and uv.lock `[[package]]` blocks with a bounded
 * line scanner (no TOML dependency): names, versions, git source evidence,
 * and hash/file integrity evidence. Anything unrecognized becomes a
 * limitation, never a guessed package.
 */
export function parsePythonLock(
  manager: PythonLockManager,
  path: string,
  content: string,
): PythonLockSummary {
  const packages: PythonLockedPackage[] = [];
  const limitations: string[] = [];
  let current: MutablePythonPackage | undefined;
  let seenPackageBlock = false;

  const flush = (): void => {
    if (current === undefined) return;
    const name = current.name === undefined ? undefined : pep503Name(current.name);
    const version = current.version === undefined ? undefined : pep440Version(current.version);
    if (name === undefined || version === undefined) {
      if (current.name !== undefined || current.version !== undefined) {
        limitations.push(`${path}: a lock package entry could not be resolved; it was skipped.`);
      }
    } else {
      packages.push({
        name,
        version,
        source: current.source,
        ...(current.url === undefined ? {} : { url: current.url }),
        ...(current.reference === undefined ? {} : { reference: current.reference }),
        ...(current.resolvedReference === undefined ? {} : { resolvedReference: current.resolvedReference }),
        integrity: current.integrity,
      });
    }
    current = undefined;
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "[[package]]") {
      flush();
      seenPackageBlock = true;
      current = { source: "registry", integrity: false, inSource: false };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("[") && !line.startsWith("[[package]]")) {
      current.inSource = /^\[package\.source\]$/u.test(line);
      continue;
    }
    const quoted = (key: string): string | undefined => {
      const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`, "u").exec(line);
      return match?.[1];
    };
    const name = quoted("name");
    if (name !== undefined && !current.inSource) {
      current.name = name;
      continue;
    }
    const version = quoted("version");
    if (version !== undefined && !current.inSource) {
      current.version = version;
      continue;
    }
    const type = quoted("type");
    if (type !== undefined && current.inSource) {
      if (type === "git") current.source = "git";
      else if (type === "legacy" || type === "directory" || type === "file" || type === "url") {
        current.source = "other";
      }
      continue;
    }
    const url = quoted("url");
    if (url !== undefined && current.inSource) {
      current.url = url;
      if (/^(?:git\+|git@|git:|ssh:)/iu.test(url)) current.source = "git";
      continue;
    }
    if (/^\s*source\s*=/u.test(line)) {
      const git = /git\s*=\s*"([^"]*)"/u.exec(line)?.[1];
      if (git !== undefined) {
        current.source = "git";
        const queryIndex = git.indexOf("?");
        current.url = queryIndex < 0 ? git : git.slice(0, queryIndex);
        const query = queryIndex < 0 ? "" : git.slice(queryIndex + 1);
        if (/^[0-9a-f]{40}$/iu.test(query)) current.resolvedReference = query;
        else if (query.length > 0) current.reference = query;
      } else if (/\b(editable|path|directory)\b/u.test(line)) {
        current.source = "other";
      }
      continue;
    }
    const reference = quoted("reference") ?? quoted("rev") ?? quoted("resolved_reference") ?? quoted("resolved-reference");
    if (reference !== undefined) {
      if (/resolved/i.test(rawLine)) current.resolvedReference = reference;
      else current.reference = reference;
      continue;
    }
    const branch = quoted("branch");
    if (branch !== undefined) {
      current.reference = `branch:${branch}`;
      continue;
    }
    const tag = quoted("tag");
    if (tag !== undefined) {
      current.reference = `tag:${tag}`;
      continue;
    }
    if (/\bfiles\s*=\s*\[|\bhash\s*=/u.test(rawLine)) {
      current.integrity = true;
    }
  }
  flush();

  if (!seenPackageBlock) {
    limitations.push(`${path}: no package entries were recognized.`);
  }
  const unique = new Map(packages.map((entry) => [`${entry.name}\0${entry.version}`, entry]));
  return {
    manager,
    path,
    packages: [...unique.values()].sort((left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    ),
    limitations: [...new Set(limitations)].sort(),
  };
}

export type PythonSpecFlavor = "poetry" | "pep621";

export interface PythonManifestDependency {
  readonly name: string;
  readonly spec: string;
  readonly flavor: PythonSpecFlavor;
  readonly markers: boolean;
}

export interface PythonManifestSummary {
  readonly path: string;
  readonly deps: readonly PythonManifestDependency[];
  readonly limitations: readonly string[];
}

/** Strips `#` comments outside double-quoted strings (escape-aware). */
function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && inString) {
      index += 1;
      continue;
    }
    if (character === '"') inString = !inString;
    if (character === "#" && !inString) return line.slice(0, index);
  }
  return line;
}

/**
 * Reads a TOML basic string, resolving backslash escapes. Returns undefined
 * when the value is not a well-formed quoted string.
 */
function unquoteBasic(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return undefined;
  const inner = trimmed.slice(1, -1);
  if (/(?:^|[^\\])(?:\\\\)*\\$/u.test(inner)) return undefined;
  return inner.replace(/\\(.)/gu, "$1");
}

/** Extracts raw (still escaped) double-quoted regions from a line. */
function quotedRegions(line: string): string[] {
  const regions: string[] = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inString && character === "\\" && index + 1 < line.length) {
      current += character + line[index + 1];
      index += 1;
      continue;
    }
    if (character === '"') {
      if (inString) {
        regions.push(current);
        current = "";
      }
      inString = !inString;
      continue;
    }
    if (inString) current += character;
  }
  return regions;
}

function parsePep508Name(value: string): { name: string; rest: string } | undefined {
  const match = /^([A-Za-z0-9._-]+)((?:\[[^\]]*\])?\s*(.*))$/u.exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const normalized = pep503Name(match[1]);
  if (normalized === undefined) return undefined;
  return { name: normalized, rest: (match[3] ?? "").trim() };
}

/**
 * Parses dependency declarations from `pyproject.toml` with a bounded line
 * scanner: Poetry `[tool.poetry.*dependencies]` tables and PEP 621
 * `[project] dependencies` arrays. setup.py, setup.cfg, and
 * requirements-only layouts are reported as limitations, never guessed.
 */
export function parsePythonManifest(path: string, content: string): PythonManifestSummary | undefined {
  const deps: PythonManifestDependency[] = [];
  const limitations: string[] = [];
  let section: "none" | "poetry-deps" | "pep621-array" | "other" = "none";
  let seenSupportedSection = false;
  let arrayDepth = 0;

  const poetrySection = (header: string): boolean =>
    header === "tool.poetry.dependencies" ||
    header === "tool.poetry.dev-dependencies" ||
    /^tool\.poetry\.group\..+\.dependencies$/u.test(header);

  for (const rawLine of content.split("\n")) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;
    const header = /^\[([^\][]+)\]$/u.exec(line)?.[1]?.trim();
    if (header !== undefined) {
      if (poetrySection(header)) {
        section = "poetry-deps";
        seenSupportedSection = true;
      } else if (header === "project") {
        section = "other";
        seenSupportedSection = true;
      } else {
        if (header === "project.optional-dependencies") {
          limitations.push(`${path}: optional dependency tables are not evaluated.`);
        }
        section = "other";
      }
      arrayDepth = 0;
      continue;
    }
    if (line.startsWith("[[") || (!line.startsWith("[") && section === "none")) continue;

    if (section === "poetry-deps") {
      const assignment = /^([A-Za-z0-9._-]+)\s*=\s*(.+)$/u.exec(line);
      if (assignment?.[1] === undefined || assignment[2] === undefined) {
        limitations.push(`${path}: an unrecognized dependency declaration was skipped.`);
        continue;
      }
      const rawName = assignment[1];
      if (rawName.toLowerCase() === "python") continue;
      const name = pep503Name(rawName);
      const value = assignment[2].trim();
      if (name === undefined) {
        limitations.push(`${path}: an unrecognized dependency declaration was skipped.`);
        continue;
      }
      const quoted = unquoteBasic(value);
      if (quoted !== undefined) {
        deps.push({ name, spec: quoted, flavor: "poetry", markers: false });
        continue;
      }
      const version = /version\s*=\s*"([^"]*)"/u.exec(value)?.[1];
      const git = /git\s*=\s*"([^"]*)"/u.exec(value)?.[1];
      if (version !== undefined && git === undefined) {
        deps.push({ name, spec: version, flavor: "poetry", markers: false });
        continue;
      }
      if (git !== undefined) {
        const ref = /rev\s*=\s*"([^"]*)"/u.exec(value)?.[1] ??
          /branch\s*=\s*"([^"]*)"/u.exec(value)?.[1] ??
          /tag\s*=\s*"([^"]*)"/u.exec(value)?.[1];
        deps.push({
          name,
          spec: `git+${git}${ref === undefined ? "" : `#${ref}`}`,
          flavor: "poetry",
          markers: false,
        });
        continue;
      }
      // Path dependencies need no lockfile and carry no version to compare.
      if (/path\s*=|develop\s*=\s*true/u.test(value)) continue;
      limitations.push(`${path}: a dependency declaration for ${name} was skipped.`);
      continue;
    }

    if (section === "other" || section === "pep621-array") {
      const arrayStart = /^dependencies\s*=\s*\[/u.exec(line);
      if (arrayStart !== null) {
        section = "pep621-array";
        arrayDepth += (line.match(/\[/gu) ?? []).length - (line.match(/\]/gu) ?? []).length;
      }
      if (section !== "pep621-array") continue;
      for (const region of quotedRegions(line)) {
        const parsed = parsePep508Name(region);
        if (parsed === undefined) {
          limitations.push(`${path}: an unrecognized dependency declaration was skipped.`);
          continue;
        }
        const markerIndex = parsed.rest.indexOf(";");
        deps.push({
          name: parsed.name,
          spec: (markerIndex < 0 ? parsed.rest : parsed.rest.slice(0, markerIndex)).trim(),
          flavor: "pep621",
          markers: markerIndex >= 0,
        });
      }
      arrayDepth += (line.match(/\[/gu) ?? []).length - (line.match(/\]/gu) ?? []).length;
      if (arrayStart !== null) arrayDepth -= (line.match(/\[/gu) ?? []).length - (line.match(/\]/gu) ?? []).length;
      if (arrayDepth <= 0) {
        section = "other";
        arrayDepth = 0;
      }
      continue;
    }
  }

  if (!seenSupportedSection) return undefined;
  const unique = new Map(deps.map((dep) => [`${dep.name}\0${dep.spec}`, dep]));
  return {
    path,
    deps: [...unique.values()].sort((left, right) => left.name.localeCompare(right.name)),
    limitations: [...new Set(limitations)].sort(),
  };
}

function compareSegments(left: string, right: string): number | undefined {
  const numeric = /^(\d+)(.*)$/u.exec(left);
  const otherNumeric = /^(\d+)(.*)$/u.exec(right);
  if (numeric === null || otherNumeric === null) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const difference = Number(numeric[1]) - Number(otherNumeric[1]);
  if (difference !== 0) return difference > 0 ? 1 : -1;
  const leftSuffix = numeric[2] ?? "";
  const rightSuffix = otherNumeric[2] ?? "";
  if (leftSuffix === rightSuffix) return 0;
  const rank = (suffix: string): number =>
    suffix === "" ? 1 : suffix.startsWith("post") ? 2 : 0;
  if (rank(leftSuffix) !== rank(rightSuffix)) {
    return rank(leftSuffix) > rank(rightSuffix) ? 1 : -1;
  }
  return leftSuffix < rightSuffix ? -1 : 1;
}

/** Compares versions numerically with pre-release awareness; undefined means undecidable. */
export function comparePythonVersions(left: string, right: string): number | undefined {
  if (left === right) return 0;
  if (left.includes("!") || right.includes("!")) return undefined;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = index < leftParts.length ? leftParts[index]! : "0";
    const rightPart = index < rightParts.length ? rightParts[index]! : "0";
    if (leftPart === rightPart) continue;
    const numeric = /^(\d+)(.*)$/u.exec(leftPart);
    const otherNumeric = /^(\d+)(.*)$/u.exec(rightPart);
    if (numeric === null || otherNumeric === null) {
      const text = compareSegments(leftPart, rightPart);
      if (text !== 0) return text;
      continue;
    }
    const difference = Number(numeric[1]) - Number(otherNumeric[1]);
    if (difference !== 0) return difference > 0 ? 1 : -1;
    if ((numeric[2] ?? "") !== (otherNumeric[2] ?? "")) {
      const text = compareSegments(numeric[2] === "" ? "0" : `0${numeric[2]}`, otherNumeric[2] === "" ? "0" : `0${otherNumeric[2]}`);
      if (text !== 0) return text;
    }
  }
  return 0;
}

function numericSegments(version: string): number[] | undefined {
  const parts = version.split(".");
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/u.test(part)) return undefined;
    numbers.push(Number(part));
  }
  return numbers;
}

function caretUpper(bound: string): string | undefined {
  const segments = numericSegments(bound);
  if (segments === undefined || segments.length === 0) return undefined;
  const index = segments.findIndex((segment) => segment !== 0);
  const bump = index === -1 ? segments.length - 1 : index;
  const upper = segments.slice(0, bump + 1);
  upper[bump]! += 1;
  return upper.join(".");
}

function tildeUpper(bound: string): string | undefined {
  const segments = numericSegments(bound);
  if (segments === undefined || segments.length === 0) return undefined;
  const bump = segments.length >= 2 ? 1 : 0;
  const upper = segments.slice(0, bump + 1);
  upper[bump]! += 1;
  return upper.join(".");
}

function compatibleUpper(bound: string): string | undefined {
  const segments = numericSegments(bound);
  if (segments === undefined || segments.length < 2) return undefined;
  const upper = segments.slice(0, -1);
  upper[upper.length - 1]! += 1;
  return upper.join(".");
}

/**
 * Decides whether a locked version satisfies a manifest specifier.
 * Returns undefined when the specifier cannot be decided (unions, arbitrary
 * equality, unparseable bounds): undecidable specs become limitations, never
 * guessed drift.
 */
export function satisfiesPythonSpec(
  version: string,
  spec: string,
  flavor: PythonSpecFlavor,
): boolean | undefined {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "*") return true;
  if (trimmed.includes("|")) return undefined;
  const clauses = trimmed.split(",").map((clause) => clause.trim()).filter((clause) => clause.length > 0);
  if (clauses.length === 0) return true;

  for (const clause of clauses) {
    const match = /^(===|==|~=|!=|>=|<=|>|<|\^|~)?\s*(.+?)\s*$/u.exec(clause);
    if (match?.[2] === undefined) return undefined;
    const operator = match[1] ?? (flavor === "poetry" ? "^" : "");
    const bound = match[2];
    if (operator === "") return true;

    if (operator === "===") {
      if (bound !== version) return false;
      continue;
    }
    if (operator === "==" && bound.endsWith(".*")) {
      const prefix = bound.slice(0, -2);
      const locked = version.split(".");
      const wanted = prefix.split(".");
      if (wanted.length > locked.length) return false;
      for (let index = 0; index < wanted.length; index += 1) {
        if (locked[index] !== wanted[index]) return false;
      }
      continue;
    }

    const compare = (other: string): number | undefined => comparePythonVersions(version, other);
    const atLeast = (other: string): boolean | undefined => {
      const result = compare(other);
      return result === undefined ? undefined : result >= 0;
    };
    const below = (other: string): boolean | undefined => {
      const result = compare(other);
      return result === undefined ? undefined : result < 0;
    };

    switch (operator) {
      case "==": {
        const result = compare(bound);
        if (result === undefined || result !== 0) return result === undefined ? undefined : false;
        break;
      }
      case "!=": {
        const result = compare(bound);
        if (result === undefined) return undefined;
        if (result === 0) return false;
        break;
      }
      case ">=": {
        const result = atLeast(bound);
        if (result !== true) return result;
        break;
      }
      case ">": {
        const result = compare(bound);
        if (result === undefined || result <= 0) return result === undefined ? undefined : false;
        break;
      }
      case "<=": {
        const result = compare(bound);
        if (result === undefined || result > 0) return result === undefined ? undefined : false;
        break;
      }
      case "<": {
        const result = below(bound);
        if (result !== true) return result;
        break;
      }
      case "~=": {
        const upper = compatibleUpper(bound);
        if (upper === undefined) return undefined;
        const low = atLeast(bound);
        if (low !== true) return low;
        const high = below(upper);
        if (high !== true) return high;
        break;
      }
      case "^": {
        const upper = caretUpper(bound);
        if (upper === undefined) return undefined;
        const low = atLeast(bound);
        if (low !== true) return low;
        const high = below(upper);
        if (high !== true) return high;
        break;
      }
      case "~": {
        const upper = tildeUpper(bound);
        if (upper === undefined) return undefined;
        const low = atLeast(bound);
        if (low !== true) return low;
        const high = below(upper);
        if (high !== true) return high;
        break;
      }
      default:
        return undefined;
    }
  }
  return true;
}

export interface PythonTargetAnalysisInput {
  readonly target: PythonAuditTarget;
  readonly lock?: PythonLockSummary;
  readonly manifests: ReadonlyMap<string, PythonManifestSummary | undefined>;
}

export interface PythonTargetAnalysisResult {
  readonly matches: readonly DependencyMatch[];
  readonly limitations: readonly string[];
}

/**
 * Applies the shared offline supply-chain rules to a Python lock root. Only
 * recorded dimensions are compared: undecidable specifiers, marker-guarded
 * dependencies, and direct-URL drift become limitations, and transitive-only
 * lock entries never produce reverse drift.
 */
export function analyzePythonTarget(
  input: PythonTargetAnalysisInput,
): PythonTargetAnalysisResult {
  const { target, lock } = input;
  const limitations = new Set<string>();
  const matches: DependencyMatch[] = target.competingLockfilePaths.map((path) => ({
    family: "competing-lockfiles" as const,
    path,
    severity: "low" as const,
    confidence: "high" as const,
  }));
  const lockPath = target.lockfile?.path ?? target.lockRoot;
  const lockedByName = new Map(
    (lock?.packages ?? []).map((entry) => [entry.name, entry]),
  );

  if (lock !== undefined) {
    for (const limitation of lock.limitations) {
      limitations.add(`${lockPath}: ${limitation}`);
    }
    for (const entry of lock.packages) {
      if (entry.source === "other") continue;
      if (entry.source === "git") {
        const url = entry.url ?? "";
        const lower = url.toLowerCase();
        if (lower.startsWith("git://")) {
          matches.push({
            family: "insecure-source",
            path: lockPath,
            packageName: entry.name,
            sourceClass: "insecure-git",
            severity: "high",
            confidence: "high",
          });
        } else if (lower.startsWith("http://")) {
          matches.push({
            family: "insecure-source",
            path: lockPath,
            packageName: entry.name,
            sourceClass: "insecure-http",
            severity: "high",
            confidence: "high",
          });
        }
        const pinned = [entry.resolvedReference, entry.reference].some((reference) =>
          reference !== undefined && FULL_SHA.test(reference.replace(/^(?:branch|tag):/u, ""))
        );
        if (!pinned && entry.reference !== undefined) {
          matches.push({
            family: "mutable-git-source",
            path: lockPath,
            packageName: entry.name,
            sourceClass: "git-mutable",
            severity: "medium",
            confidence: "high",
          });
        } else if (!pinned) {
          limitations.add(
            `${lockPath}: git source pinning for ${entry.name} could not be verified.`,
          );
        }
        continue;
      }
      if (!entry.integrity) {
        matches.push({
          family: "missing-integrity",
          path: lockPath,
          packageName: entry.name,
          sourceClass: "registry",
          severity: "medium",
          confidence: "high",
        });
      }
    }
  }

  for (const project of target.coveredProjects) {
    if (project.manifestPath === undefined) {
      limitations.add(`${project.root}: pyproject.toml manifest path is unavailable.`);
      continue;
    }
    const manifest = input.manifests.get(project.manifestPath);
    if (manifest === undefined) {
      limitations.add(`${project.manifestPath}: manifest content is unavailable.`);
      continue;
    }
    for (const limitation of manifest.limitations) limitations.add(limitation);

    const isLocal = (spec: string): boolean => {
      const sourceClass = classifyDependencySource(spec).sourceClass;
      return sourceClass === "local-file" ||
        sourceClass === "local-link" ||
        sourceClass === "workspace";
    };
    const external = manifest.deps.filter((dep) => !isLocal(dep.spec));

    for (const dep of manifest.deps) {
      const classification = classifyDependencySource(dep.spec).sourceClass;
      if (classification === "insecure-http" || classification === "insecure-git") {
        matches.push({
          family: "insecure-source",
          path: manifest.path,
          packageName: dep.name,
          sourceClass: classification,
          severity: "high",
          confidence: "high",
        });
      } else if (classification === "git-mutable") {
        matches.push({
          family: "mutable-git-source",
          path: manifest.path,
          packageName: dep.name,
          sourceClass: classification,
          severity: "medium",
          confidence: "high",
        });
      }
    }

    if (lock === undefined) {
      if (external.length > 0) {
        matches.push({
          family: "missing-lockfile",
          path: manifest.path,
          severity: "medium",
          confidence: "high",
        });
      }
      continue;
    }

    let directExcluded = false;
    let markerSkipped = false;
    let undecidable = 0;
    for (const dep of external) {
      const classification = classifyDependencySource(dep.spec).sourceClass;
      if (
        classification === "git-pinned" ||
        classification === "git-mutable" ||
        classification === "secure-https" ||
        classification === "secure-ssh"
      ) {
        directExcluded = true;
        continue;
      }
      if (
        classification === "local-file" ||
        classification === "local-link" ||
        classification === "workspace" ||
        classification === "unknown"
      ) {
        directExcluded = true;
        continue;
      }
      if (dep.markers) {
        markerSkipped = true;
        continue;
      }
      const locked = lockedByName.get(dep.name);
      if (locked === undefined) {
        matches.push({
          family: "manifest-lock-drift",
          path: manifest.path,
          packageName: dep.name,
          severity: "medium",
          confidence: "high",
        });
        continue;
      }
      const satisfied = satisfiesPythonSpec(locked.version, dep.spec, dep.flavor);
      if (satisfied === false) {
        matches.push({
          family: "manifest-lock-drift",
          path: manifest.path,
          packageName: dep.name,
          severity: "medium",
          confidence: "high",
        });
      } else if (satisfied === undefined) {
        undecidable += 1;
      }
    }
    if (directExcluded) {
      limitations.add(`${manifest.path}: direct-URL requirements were excluded from drift analysis.`);
    }
    if (markerSkipped) {
      limitations.add(`${manifest.path}: environment markers are not evaluated; guarded requirements were excluded from drift analysis.`);
    }
    if (undecidable > 0) {
      limitations.add(
        `${manifest.path}: ${undecidable} version specifier(s) could not be decided; drift was withheld for them.`,
      );
    }
  }

  const uniqueMatches = new Map<string, DependencyMatch>();
  for (const match of matches) {
    uniqueMatches.set(
      `${match.family}\0${match.path}\0${match.packageName ?? ""}`,
      match,
    );
  }

  return {
    matches: [...uniqueMatches.values()],
    limitations: [...limitations].sort(),
  };
}
