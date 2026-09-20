import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import { safeNpmPackageName } from "../dependencies/source.js";

export type LockEcosystem = "npm" | "PyPI";

export interface ResolvedPackage {
  readonly ecosystem: LockEcosystem;
  readonly name: string;
  readonly version: string;
}

export type LockFormat =
  | "package-lock.json"
  | "pnpm-lock.yaml"
  | "yarn.lock"
  | "bun.lock"
  | "poetry.lock"
  | "uv.lock";

export interface LockfileScan {
  readonly status: "supported" | "unsupported" | "invalid";
  readonly format: LockFormat;
  readonly packages: readonly ResolvedPackage[];
  readonly reason?: string;
}

const NPM_VERSION_PATTERN = /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/u;
const PYPI_VERSION_PATTERN = /^\d+(?:\.\d+)*(?:[A-Za-z0-9.+-]*)$/u;
const PYPI_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

export const SUPPORTED_LOCKFILES: readonly LockFormat[] = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "poetry.lock",
  "uv.lock",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function npmVersion(value: unknown): string | undefined {
  return typeof value === "string" && NPM_VERSION_PATTERN.test(value) ? value : undefined;
}

function uniquePackages(packages: readonly ResolvedPackage[]): ResolvedPackage[] {
  const byIdentity = new Map<string, ResolvedPackage>();
  for (const entry of packages) {
    byIdentity.set(`${entry.ecosystem}:${entry.name}@${entry.version}`, entry);
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      left.ecosystem.localeCompare(right.ecosystem) ||
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );
}

/**
 * Name of the package at an npm lock `packages` path such as
 * `node_modules/foo/node_modules/@scope/bar`. Returns undefined for the root
 * entry and for paths that do not describe an installed package.
 */
export function packageNameFromLockPath(path: string): string | undefined {
  if (path.length === 0) return undefined;

  const segments = path.split("/");
  let index = -1;
  for (let cursor = segments.length - 1; cursor >= 0; cursor -= 1) {
    if (segments[cursor] === "node_modules") {
      index = cursor;
      break;
    }
  }
  if (index === -1 || index === segments.length - 1) return undefined;

  const tail = segments.slice(index + 1);
  const candidate = tail[0]?.startsWith("@") ? tail.slice(0, 2).join("/") : tail[0];
  return candidate === undefined ? undefined : safeNpmPackageName(candidate);
}

function scanPackageLock(content: string): LockfileScan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: "invalid", format: "package-lock.json", packages: [], reason: "lockfile is not valid JSON" };
  }
  if (!isObject(parsed)) {
    return { status: "invalid", format: "package-lock.json", packages: [], reason: "lockfile must contain a JSON object" };
  }
  const lockfileVersion = parsed["lockfileVersion"];
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    return {
      status: "unsupported",
      format: "package-lock.json",
      packages: [],
      reason: `unsupported npm lockfileVersion ${String(lockfileVersion)}`,
    };
  }
  const packagesSection = parsed["packages"];
  if (!isObject(packagesSection)) {
    return { status: "unsupported", format: "package-lock.json", packages: [], reason: "lockfile has no packages section" };
  }

  const packages: ResolvedPackage[] = [];
  for (const [path, entry] of Object.entries(packagesSection)) {
    if (!isObject(entry) || entry["link"] === true) continue;
    const name = packageNameFromLockPath(path);
    const version = npmVersion(entry["version"]);
    if (name !== undefined && version !== undefined) packages.push({ ecosystem: "npm", name, version });
  }

  return { status: "supported", format: "package-lock.json", packages: uniquePackages(packages) };
}

function pnpmNameVersionFromKey(key: string, lockfileMajor: number): { name: string; version: string } | undefined {
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

function scanPnpmLock(content: string): LockfileScan {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return { status: "invalid", format: "pnpm-lock.yaml", packages: [], reason: "lockfile is not valid YAML" };
  }
  if (!isObject(parsed)) {
    return { status: "invalid", format: "pnpm-lock.yaml", packages: [], reason: "lockfile must contain a YAML mapping" };
  }

  const versionValue = parsed["lockfileVersion"];
  const major = typeof versionValue === "number"
    ? Math.floor(versionValue)
    : typeof versionValue === "string"
      ? Number.parseInt(versionValue, 10)
      : Number.NaN;
  if (!Number.isInteger(major) || major < 5) {
    return {
      status: "unsupported",
      format: "pnpm-lock.yaml",
      packages: [],
      reason: `unsupported pnpm lockfileVersion ${String(versionValue)}`,
    };
  }

  const packages: ResolvedPackage[] = [];
  for (const section of ["packages", "snapshots"]) {
    const entries = parsed[section];
    if (!isObject(entries)) continue;
    for (const key of Object.keys(entries)) {
      const parsedKey = pnpmNameVersionFromKey(key, major);
      if (parsedKey === undefined) continue;
      const name = safeNpmPackageName(parsedKey.name);
      if (name === undefined || !NPM_VERSION_PATTERN.test(parsedKey.version)) continue;
      packages.push({ ecosystem: "npm", name, version: parsedKey.version });
    }
  }

  return { status: "supported", format: "pnpm-lock.yaml", packages: uniquePackages(packages) };
}

function yarnNameFromV1Header(header: string): string | undefined {
  const first = header.split(",")[0]!.trim().replace(/^"|"$/gu, "");
  if (first.startsWith("@")) {
    const parts = first.split("@");
    return parts.length >= 3 ? `@${parts[1]}` : undefined;
  }
  return first.split("@")[0];
}

function scanYarnV1(content: string): ResolvedPackage[] {
  const packages: ResolvedPackage[] = [];
  let currentName: string | undefined;

  for (const line of content.split("\n")) {
    if (line.length === 0) continue;

    if (!/^\s/u.test(line)) {
      const trimmed = line.trim();
      currentName = trimmed.endsWith(":")
        ? yarnNameFromV1Header(trimmed.slice(0, -1))
        : undefined;
      continue;
    }

    if (currentName === undefined) continue;
    const match = /^\s+version\s+"?([^"\s]+)"?/u.exec(line);
    const version = match?.[1];
    if (version !== undefined && NPM_VERSION_PATTERN.test(version)) {
      const name = safeNpmPackageName(currentName);
      if (name !== undefined) packages.push({ ecosystem: "npm", name, version });
      currentName = undefined;
    }
  }

  return packages;
}

function scanYarnBerry(content: string): ResolvedPackage[] {
  const packages: ResolvedPackage[] = [];
  const parsed = parseYaml(content);
  if (!isObject(parsed)) return packages;

  for (const [key, value] of Object.entries(parsed)) {
    const protocolIndex = key.indexOf("@npm:");
    if (protocolIndex <= 0 || !isObject(value)) continue;
    const name = safeNpmPackageName(key.slice(0, protocolIndex));
    const version = npmVersion(value["version"]);
    if (name !== undefined && version !== undefined) {
      packages.push({ ecosystem: "npm", name, version });
    }
  }

  return packages;
}

function scanYarnLock(content: string): LockfileScan {
  const isV1 = /# yarn lockfile v1/u.test(content) || !/__metadata:/u.test(content);
  if (isV1) {
    return { status: "supported", format: "yarn.lock", packages: uniquePackages(scanYarnV1(content)) };
  }
  try {
    return { status: "supported", format: "yarn.lock", packages: uniquePackages(scanYarnBerry(content)) };
  } catch {
    return { status: "invalid", format: "yarn.lock", packages: [], reason: "yarn.lock is not valid YAML" };
  }
}

function scanBunLock(content: string): LockfileScan {
  const parsed: unknown = parseJsonc(content);
  if (!isObject(parsed)) {
    return { status: "invalid", format: "bun.lock", packages: [], reason: "bun.lock is not valid JSONC" };
  }
  const entries = parsed["packages"];
  if (!isObject(entries)) {
    return { status: "unsupported", format: "bun.lock", packages: [], reason: "bun.lock has no packages section" };
  }

  const packages: ResolvedPackage[] = [];
  for (const key of Object.keys(entries)) {
    const separator = key.startsWith("@") ? key.lastIndexOf("@") : key.indexOf("@");
    if (separator <= 0) continue;
    const name = safeNpmPackageName(key.slice(0, separator));
    const version = npmVersion(key.slice(separator + 1));
    if (name !== undefined && version !== undefined) {
      packages.push({ ecosystem: "npm", name, version });
    }
  }

  return { status: "supported", format: "bun.lock", packages: uniquePackages(packages) };
}

function scanPythonLock(content: string, format: "poetry.lock" | "uv.lock"): LockfileScan {
  const packages: ResolvedPackage[] = [];
  let name: string | undefined;
  let version: string | undefined;

  const flush = (): void => {
    if (name !== undefined && version !== undefined) {
      packages.push({ ecosystem: "PyPI", name, version });
    }
    name = undefined;
    version = undefined;
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "[[package]]") {
      flush();
      continue;
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"/u.exec(line);
    if (nameMatch?.[1] !== undefined && PYPI_NAME_PATTERN.test(nameMatch[1])) {
      name = nameMatch[1];
      continue;
    }
    const versionMatch = /^version\s*=\s*"([^"]+)"/u.exec(line);
    if (versionMatch?.[1] !== undefined && PYPI_VERSION_PATTERN.test(versionMatch[1])) {
      version = versionMatch[1];
    }
  }
  flush();

  const hasPackages = content.includes("[[package]]");
  if (!hasPackages && packages.length === 0) {
    return { status: "unsupported", format, packages: [], reason: `${format} has no package entries` };
  }
  return { status: "supported", format, packages: uniquePackages(packages) };
}

/**
 * Dispatches on the lockfile name and returns only resolved registry package
 * names and versions. Workspace links, git/file/URL sources, and anything
 * without a plain version are reported as coverage limitations by the caller.
 */
export function scanLockfile(path: string, content: string): LockfileScan {
  const basename = path.split("/").at(-1) ?? path;

  switch (basename) {
    case "package-lock.json":
      return scanPackageLock(content);
    case "pnpm-lock.yaml":
      return scanPnpmLock(content);
    case "yarn.lock":
      return scanYarnLock(content);
    case "bun.lock":
      return scanBunLock(content);
    case "poetry.lock":
      return scanPythonLock(content, "poetry.lock");
    case "uv.lock":
      return scanPythonLock(content, "uv.lock");
    default:
      return {
        status: "unsupported",
        format: "package-lock.json",
        packages: [],
        reason: `${basename} is not a supported advisory lockfile`,
      };
  }
}

export function lockfileFormatForPath(path: string): LockFormat | undefined {
  const basename = path.split("/").at(-1);
  return SUPPORTED_LOCKFILES.find((format) => format === basename);
}
