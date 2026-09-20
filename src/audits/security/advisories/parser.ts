import { safeNpmPackageName } from "../dependencies/source.js";

export interface ResolvedPackage {
  readonly name: string;
  readonly version: string;
}

export interface ResolvedPackageScan {
  readonly status: "supported" | "unsupported" | "invalid";
  readonly packages: readonly ResolvedPackage[];
  readonly version?: 2 | 3;
  readonly reason?: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Name of the package at a lock `packages` path such as
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

/**
 * Extracts only resolved registry package names and versions from an npm
 * package-lock v2/v3 document. Workspace links, git/file/URL sources, and
 * anything without a plain semantic version are left out and reported as a
 * bounded coverage limitation by the caller.
 */
export function scanResolvedPackages(content: string): ResolvedPackageScan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: "invalid", packages: [], reason: "lockfile is not valid JSON" };
  }

  if (!isObject(parsed)) {
    return { status: "invalid", packages: [], reason: "lockfile must contain a JSON object" };
  }

  const lockfileVersion = parsed["lockfileVersion"];
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    return {
      status: "unsupported",
      packages: [],
      reason: `unsupported npm lockfileVersion ${String(lockfileVersion)}`,
    };
  }

  const packagesSection = parsed["packages"];
  if (!isObject(packagesSection)) {
    return { status: "unsupported", packages: [], reason: "lockfile has no packages section" };
  }

  const byIdentity = new Map<string, ResolvedPackage>();

  for (const [path, entry] of Object.entries(packagesSection)) {
    if (!isObject(entry)) continue;
    if (entry["link"] === true) continue;

    const name = packageNameFromLockPath(path);
    const version = entry["version"];
    if (name === undefined || typeof version !== "string" || !VERSION_PATTERN.test(version)) {
      continue;
    }

    byIdentity.set(`${name}@${version}`, { name, version });
  }

  const packages = [...byIdentity.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );

  return { status: "supported", packages, version: lockfileVersion };
}
