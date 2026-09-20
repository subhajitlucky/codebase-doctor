import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import { classifyDependencySource, safeNpmPackageName } from "./source.js";
import type { SafeSourceClass } from "./types.js";

export type NodeLockFormat = "pnpm" | "yarn-v1" | "yarn-berry" | "bun";

export type IntegrityEvidence = "present" | "missing" | "invalid";

export interface NodeLockPackage {
  readonly name: string;
  readonly version: string;
  readonly resolution?: string;
  readonly integrity: IntegrityEvidence;
  readonly sourceClass: SafeSourceClass;
}

export interface NodeLockSummary {
  readonly format: NodeLockFormat;
  readonly packages: readonly NodeLockPackage[];
  /** Direct dependency name to recorded manifest range, keyed by importer path ("." for the root). */
  readonly specifiers: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly specifiersRecorded: boolean;
  /** True when recorded specifiers describe direct dependencies only and reverse drift is safe. */
  readonly directSpecifiersComplete: boolean;
  readonly limitations: readonly string[];
  readonly complete: boolean;
}

const NPM_VERSION_PATTERN = /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/u;
const INTEGRITY_PATTERN = /^sha(?:1|256|512)-[A-Za-z0-9+/=]+$/iu;
const SHA1_FRAGMENT = /#([0-9a-f]{40})$/iu;
const FULL_GIT_COMMIT = /[0-9a-f]{40}/iu;
const MAX_LIMITATIONS = 50;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integrityEvidence(value: unknown): IntegrityEvidence {
  if (value === undefined || value === null || value === "") return "missing";
  return typeof value === "string" && INTEGRITY_PATTERN.test(value.trim())
    ? "present"
    : "invalid";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function classifyResolution(resolution: string | undefined): {
  sourceClass: SafeSourceClass;
  integrityExpected: boolean;
  resolved?: string;
} {
  if (resolution === undefined || resolution.trim() === "") {
    return { sourceClass: "registry", integrityExpected: true };
  }
  const trimmed = resolution.trim();
  const gitStyle = /(?:@git:|^git:|git\+)/iu.test(trimmed);
  if (gitStyle) {
    const pinned = FULL_GIT_COMMIT.test(trimmed) || /commit=[0-9a-f]{40}/iu.test(trimmed);
    const insecure = /git\+(?:http|git):\/\//iu.test(trimmed) || /^git:\/\//iu.test(trimmed);
    return {
      sourceClass: insecure ? "insecure-git" : pinned ? "git-pinned" : "git-mutable",
      integrityExpected: false,
      resolved: trimmed,
    };
  }
  const classification = classifyDependencySource(trimmed);
  if (classification.sourceClass === "unknown" && /@npm:/u.test(trimmed)) {
    return { sourceClass: "registry", integrityExpected: true, resolved: trimmed };
  }
  if (classification.sourceClass === "unknown" && /^@?[^@\s/]+(?:\/[^@\s/]+)?@\d/u.test(trimmed)) {
    return { sourceClass: "registry", integrityExpected: true, resolved: trimmed };
  }
  const integrityExpected =
    classification.sourceClass !== "local-file" &&
    classification.sourceClass !== "local-link" &&
    classification.sourceClass !== "workspace" &&
    classification.sourceClass !== "git-pinned" &&
    classification.sourceClass !== "git-mutable";
  return {
    sourceClass: classification.sourceClass,
    integrityExpected,
    resolved: trimmed,
  };
}

function packageFrom(
  name: string,
  version: string,
  resolution: string | undefined,
  integrity: IntegrityEvidence,
): NodeLockPackage | undefined {
  const safeName = safeNpmPackageName(name);
  if (safeName === undefined || !NPM_VERSION_PATTERN.test(version)) return undefined;
  const classified = classifyResolution(resolution);
  const integrityState = classified.integrityExpected ? integrity : "present";
  return {
    name: safeName,
    version,
    ...(classified.resolved === undefined ? {} : { resolution: classified.resolved }),
    integrity: integrityState,
    sourceClass: classified.sourceClass,
  };
}

function emptySummary(
  format: NodeLockFormat,
  limitations: readonly string[] = [],
  complete = true,
): NodeLockSummary {
  return {
    format,
    packages: [],
    specifiers: new Map(),
    specifiersRecorded: false,
    directSpecifiersComplete: false,
    limitations: [...new Set(limitations)].slice(0, MAX_LIMITATIONS),
    complete,
  };
}

interface MutableSpecifiers {
  readonly byImporter: Map<string, Map<string, string[]>>;
}

function addSpecifier(
  specifiers: MutableSpecifiers,
  importer: string,
  name: string,
  range: string,
): void {
  if (safeNpmPackageName(name) === undefined) return;
  const byName = specifiers.byImporter.get(importer) ?? new Map<string, string[]>();
  const ranges = byName.get(name) ?? [];
  ranges.push(range);
  byName.set(name, ranges);
  specifiers.byImporter.set(importer, byName);
}

function freezeSpecifiers(specifiers: MutableSpecifiers): Map<string, Map<string, readonly string[]>> {
  const frozen = new Map<string, Map<string, readonly string[]>>();
  for (const [importer, byName] of specifiers.byImporter) {
    const entries = new Map<string, readonly string[]>();
    for (const [name, ranges] of byName) entries.set(name, unique(ranges));
    frozen.set(importer, entries);
  }
  return frozen;
}

function pnpmNameVersionFromKey(
  key: string,
  lockfileMajor: number,
): { name: string; version: string } | undefined {
  const raw = key.startsWith("/") ? key.slice(1) : key;
  if (lockfileMajor >= 9) {
    const match = /^(?<name>@[^/]+\/[^@]+|[^@/]+)@(?<version>[^()]+)/u.exec(raw);
    const name = match?.groups?.["name"];
    const version = match?.groups?.["version"];
    return name === undefined || version === undefined ? undefined : { name, version };
  }
  const peerless = raw.split("(")[0]!.split("_")[0]!;
  const segments = peerless.split("/").filter((segment) => segment.length > 0);
  const name = segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const version = segments[0]?.startsWith("@") ? segments[2] : segments[1];
  return name === undefined || version === undefined ? undefined : { name, version };
}

function pnpmResolution(raw: unknown): {
  resolution: string | undefined;
  integrity: IntegrityEvidence;
} {
  if (!isObject(raw)) return { resolution: undefined, integrity: "missing" };
  const integrity = integrityEvidence(raw["integrity"]);
  if (typeof raw["tarball"] === "string") {
    return { resolution: raw["tarball"], integrity };
  }
  if (typeof raw["repo"] === "string") {
    const commit = typeof raw["commit"] === "string" ? raw["commit"] : undefined;
    return {
      resolution: commit === undefined ? raw["repo"] : `git+${raw["repo"]}#${commit}`,
      integrity: commit === undefined ? "missing" : integrity,
    };
  }
  if (typeof raw["directory"] === "string") {
    return { resolution: `link:${raw["directory"]}`, integrity };
  }
  return { resolution: undefined, integrity };
}

function scanPnpm(content: string): NodeLockSummary {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return emptySummary("pnpm", ["pnpm-lock.yaml is not valid YAML."], false);
  }
  if (!isObject(parsed)) {
    return emptySummary("pnpm", ["pnpm-lock.yaml must contain a YAML mapping."], false);
  }
  const versionValue = parsed["lockfileVersion"];
  const major = typeof versionValue === "number"
    ? Math.floor(versionValue)
    : typeof versionValue === "string"
      ? Number.parseInt(versionValue, 10)
      : Number.NaN;
  if (!Number.isInteger(major) || major < 5) {
    return emptySummary("pnpm", [`Unsupported pnpm lockfileVersion ${String(versionValue)}.`], false);
  }

  const limitations: string[] = [];
  const specifiers: MutableSpecifiers = { byImporter: new Map() };
  const importers = parsed["importers"];
  if (isObject(importers)) {
    for (const [importer, value] of Object.entries(importers)) {
      if (!isObject(value)) continue;
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const entries = value[section];
        if (!isObject(entries)) continue;
        for (const [name, entry] of Object.entries(entries)) {
          const range = isObject(entry) && typeof entry["specifier"] === "string"
            ? entry["specifier"]
            : undefined;
          if (range !== undefined) addSpecifier(specifiers, importer, name, range);
          else limitations.push(`${importer}: ${name} records no importer specifier.`);
        }
      }
    }
  } else {
    limitations.push("pnpm lockfile has no importers section; manifest-lock drift was not compared.");
  }

  const packages = new Map<string, NodeLockPackage>();
  for (const section of ["packages", "snapshots"]) {
    const entries = parsed[section];
    if (!isObject(entries)) continue;
    for (const [key, value] of Object.entries(entries)) {
      const parsedKey = pnpmNameVersionFromKey(key, major);
      if (parsedKey === undefined) continue;
      const { resolution, integrity } = pnpmResolution(
        isObject(value) ? value["resolution"] : undefined,
      );
      if (!NPM_VERSION_PATTERN.test(parsedKey.version)) {
        const safeName = safeNpmPackageName(parsedKey.name);
        if (safeName !== undefined && resolution !== undefined) {
          const classified = classifyResolution(resolution);
          packages.set(`${safeName}@${parsedKey.version}`, {
            name: safeName,
            version: parsedKey.version,
            resolution,
            integrity: "present",
            sourceClass: classified.sourceClass,
          });
        }
        continue;
      }
      const entry = packageFrom(parsedKey.name, parsedKey.version, resolution, integrity);
      if (entry !== undefined) packages.set(`${entry.name}@${entry.version}`, entry);
    }
  }

  return {
    format: "pnpm",
    packages: [...packages.values()].sort(
      (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    ),
    specifiers: freezeSpecifiers(specifiers),
    specifiersRecorded: specifiers.byImporter.size > 0,
    directSpecifiersComplete: true,
    limitations: unique(limitations).slice(0, MAX_LIMITATIONS),
    complete: limitations.length === 0,
  };
}

interface YarnV1Block {
  headers: string[];
  version?: string;
  resolved?: string;
  integrity?: string;
}

function yarnNameAndRange(descriptor: string): { name: string; range: string } | undefined {
  const trimmed = descriptor.trim().replace(/^"|"$/gu, "");
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    const separator = trimmed.indexOf("@", slash);
    if (slash < 0 || separator < 0) return undefined;
    return { name: trimmed.slice(0, separator), range: trimmed.slice(separator + 1) };
  }
  const separator = trimmed.indexOf("@");
  if (separator <= 0) return undefined;
  return { name: trimmed.slice(0, separator), range: trimmed.slice(separator + 1) };
}

function scanYarnV1(content: string): NodeLockSummary {
  const limitations: string[] = [];
  const specifiers: MutableSpecifiers = { byImporter: new Map() };
  const packages: NodeLockPackage[] = [];
  let block: YarnV1Block | undefined;

  const flush = (): void => {
    if (block === undefined) return;
    const parsedHeader = yarnNameAndRange(block.headers[0] ?? "");
    if (parsedHeader !== undefined) {
      const fragment = block.resolved === undefined
        ? undefined
        : block.resolved.match(SHA1_FRAGMENT)?.[1];
      const integrity = block.integrity !== undefined
        ? integrityEvidence(block.integrity)
        : fragment !== undefined ? "present" : "missing";
      const entry = packageFrom(parsedHeader.name, block.version ?? "", block.resolved, integrity);
      if (entry !== undefined) packages.push(entry);
    }
    for (const header of block.headers) {
      const parsed = yarnNameAndRange(header);
      if (parsed !== undefined) addSpecifier(specifiers, ".", parsed.name, parsed.range);
    }
    block = undefined;
  };

  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    if (!/^\s/u.test(line)) {
      flush();
      const header = line.trim();
      if (header.startsWith("#")) continue;
      if (!header.endsWith(":")) return emptySummary("yarn-v1", ["yarn.lock has an invalid entry header."], false);
      block = { headers: header.slice(0, -1).split(",").map((part) => part.trim()) };
      continue;
    }
    if (block === undefined) continue;
    const field = /^\s+(\S+)\s+"?([^"\s]+)"?/u.exec(line);
    const fieldName = field?.[1];
    const fieldValue = field?.[2];
    if (fieldName === undefined || fieldValue === undefined) continue;
    if (fieldName === "version") block.version = fieldValue;
    if (fieldName === "resolved") block.resolved = fieldValue;
    if (fieldName === "integrity") block.integrity = fieldValue;
  }
  flush();

  return {
    format: "yarn-v1",
    packages: packages.sort(
      (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    ),
    specifiers: freezeSpecifiers(specifiers),
    specifiersRecorded: specifiers.byImporter.size > 0,
    directSpecifiersComplete: false,
    limitations: unique(limitations).slice(0, MAX_LIMITATIONS),
    complete: limitations.length === 0,
  };
}

function berryNameAndRange(key: string): { name: string; range: string } | undefined {
  const descriptor = key.split(",")[0]!.trim().replace(/^"|"$/gu, "");
  const separator = descriptor.indexOf("@", 1);
  if (separator <= 0) return undefined;
  const name = descriptor.slice(0, separator);
  const protocol = descriptor.slice(separator + 1);
  const colon = protocol.indexOf(":");
  return { name, range: colon < 0 ? protocol : protocol.slice(colon + 1) };
}

function scanYarnBerry(content: string): NodeLockSummary {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return emptySummary("yarn-berry", ["yarn.lock is not valid YAML."], false);
  }
  if (!isObject(parsed)) {
    return emptySummary("yarn-berry", ["yarn.lock must contain a YAML mapping."], false);
  }

  const limitations: string[] = [];
  const specifiers: MutableSpecifiers = { byImporter: new Map() };
  const packages: NodeLockPackage[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "__metadata" || !isObject(value)) continue;
    const parsedKey = berryNameAndRange(key);
    const version = typeof value["version"] === "string" ? value["version"] : undefined;
    const resolution = typeof value["resolution"] === "string" ? value["resolution"] : undefined;
    if (parsedKey !== undefined) {
      addSpecifier(specifiers, ".", parsedKey.name, parsedKey.range);
    }
    if (parsedKey === undefined || version === undefined) continue;
    if (/@(?:workspace|portal|link|patch|exec):/u.test(resolution ?? "")) continue;
    const checksum = value["checksum"];
    const integrity = checksum === undefined
      ? "missing"
      : typeof checksum === "string" && checksum.includes("/") ? "present" : "invalid";
    const entry = packageFrom(parsedKey.name, version, resolution, integrity);
    if (entry !== undefined) packages.push(entry);
  }

  return {
    format: "yarn-berry",
    packages: packages.sort(
      (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    ),
    specifiers: freezeSpecifiers(specifiers),
    specifiersRecorded: specifiers.byImporter.size > 0,
    directSpecifiersComplete: false,
    limitations: unique(limitations).slice(0, MAX_LIMITATIONS),
    complete: limitations.length === 0,
  };
}

function scanBun(content: string): NodeLockSummary {
  const parsed: unknown = parseJsonc(content);
  if (!isObject(parsed)) {
    return emptySummary("bun", ["bun.lock is not valid JSONC."], false);
  }
  const entries = parsed["packages"];
  if (!isObject(entries)) {
    return emptySummary("bun", ["bun.lock has no packages section."], false);
  }

  const limitations: string[] = [];
  const specifiers: MutableSpecifiers = { byImporter: new Map() };
  const workspaces = parsed["workspaces"];
  if (isObject(workspaces)) {
    for (const [importer, value] of Object.entries(workspaces)) {
      if (!isObject(value)) continue;
      for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const sectionValue = value[section];
        if (!isObject(sectionValue)) continue;
        for (const [name, range] of Object.entries(sectionValue)) {
          if (typeof range === "string") addSpecifier(specifiers, importer === "" ? "." : importer, name, range);
        }
      }
    }
  } else {
    limitations.push("bun.lock has no workspaces section; manifest-lock drift was not compared.");
  }

  const packages: NodeLockPackage[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const separator = key.startsWith("@") ? key.lastIndexOf("@") : key.indexOf("@");
    if (separator <= 0) continue;
    const name = key.slice(0, separator);
    const version = key.slice(separator + 1);
    const safeName = safeNpmPackageName(name);
    if (safeName === undefined) continue;
    if (!NPM_VERSION_PATTERN.test(version)) {
      if (/^(?:git\+|git:|https?:|file:|link:|workspace:)/iu.test(version)) {
        const classified = classifyResolution(version);
        packages.push({
          name: safeName,
          version,
          resolution: version,
          integrity: "present",
          sourceClass: classified.sourceClass,
        });
      } else {
        limitations.push(`${key}: bun.lock package entry has a non-registry version.`);
      }
      continue;
    }
    let resolution: string | undefined;
    let integrity: IntegrityEvidence = "missing";
    if (Array.isArray(value)) {
      resolution = value.find((element): element is string =>
        typeof element === "string" && (/^(?:https?|git|file|link|workspace):/iu.test(element) || element.includes("@"))
      );
      integrity = integrityEvidence(value.find((element): element is string =>
        typeof element === "string" && INTEGRITY_PATTERN.test(element)
      ));
      if (resolution === `${name}@${version}`) resolution = undefined;
    } else if (isObject(value)) {
      resolution = typeof value["resolution"] === "string" ? value["resolution"] : undefined;
      integrity = integrityEvidence(value["integrity"]);
    } else {
      limitations.push(`${key}: bun.lock package entry has an unsupported shape.`);
      continue;
    }
    const entry = packageFrom(name, version, resolution, integrity);
    if (entry !== undefined) packages.push(entry);
  }

  return {
    format: "bun",
    packages: packages.sort(
      (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    ),
    specifiers: freezeSpecifiers(specifiers),
    specifiersRecorded: specifiers.byImporter.size > 0,
    directSpecifiersComplete: true,
    limitations: unique(limitations).slice(0, MAX_LIMITATIONS),
    complete: limitations.length === 0,
  };
}

export function nodeLockFormatForPath(path: string): NodeLockFormat | "yarn" | undefined {
  const basename = path.split("/").at(-1);
  if (basename === "pnpm-lock.yaml") return "pnpm";
  if (basename === "bun.lock") return "bun";
  if (basename === "yarn.lock") return "yarn";
  return undefined;
}

export function parseNodeLock(path: string, content: string): NodeLockSummary | undefined {
  const format = nodeLockFormatForPath(path);
  if (format === "pnpm") return scanPnpm(content);
  if (format === "bun") return scanBun(content);
  if (format === "yarn") {
    const isV1 = /# yarn lockfile v1/u.test(content) || !/__metadata:/u.test(content);
    return isV1 ? scanYarnV1(content) : scanYarnBerry(content);
  }
  return undefined;
}
