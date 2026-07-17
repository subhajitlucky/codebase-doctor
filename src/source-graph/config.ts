import { posix } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { FileInventory, FileRecord } from "../workspace/types.js";

type JsonObject = Record<string, unknown>;

export const DEFAULT_MAX_CONFIG_EXTENDS_DEPTH = 8;

export interface SafeSourceAlias {
  readonly configPath: string;
  readonly wildcard: boolean;
}

export interface SourceAliasConfig {
  readonly path: string;
  readonly directory: string;
  readonly basePath: string;
  readonly aliases: readonly SafeSourceAlias[];
}

export interface SourceAliasConfigResult {
  readonly status: "completed" | "partial" | "not-applicable";
  readonly configs: readonly SourceAliasConfig[];
  readonly limitations: readonly string[];
}

export interface SourceAliasConfigOptions {
  readonly maxExtendsDepth?: number;
}

interface ResolvedOptions {
  readonly basePath: string;
  readonly aliases: readonly SafeSourceAlias[];
}

const patterns = new WeakMap<SafeSourceAlias, string>();
const targets = new WeakMap<SafeSourceAlias, readonly string[]>();

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function directoryOf(path: string): string {
  const directory = posix.dirname(path);
  return directory === "" ? "." : directory;
}

function inside(directory: string, path: string): boolean {
  return directory === "." || path === directory || path.startsWith(`${directory}/`);
}

function safeRepositoryPath(base: string, value: string): string | undefined {
  if (value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  const normalized = posix.normalize(posix.join(base === "." ? "" : base, value));
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized.length === 0 ? "." : normalized;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isPrimaryConfig(path: string): boolean {
  const basename = posix.basename(path);
  return basename === "tsconfig.json" || basename === "jsconfig.json";
}

function aliasIsSupported(pattern: string): boolean {
  return /^(?:@?[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.*-]+)*$/.test(pattern) &&
    (pattern.match(/\*/g)?.length ?? 0) <= 1;
}

function targetIsSupported(basePath: string, target: string): boolean {
  if ((target.match(/\*/g)?.length ?? 0) > 1) return false;
  return safeRepositoryPath(basePath, target.replace("*", "__codebase_doctor_wildcard__")) !== undefined;
}

function createAliases(
  configPath: string,
  basePath: string,
  value: unknown,
  limitations: Set<string>,
): SafeSourceAlias[] | undefined {
  if (value === undefined) return undefined;
  const entries = objectValue(value);
  if (entries === undefined) {
    limitations.add(`${configPath}: source alias mappings are invalid.`);
    return [];
  }
  const aliases: SafeSourceAlias[] = [];
  for (const pattern of Object.keys(entries).sort()) {
    const rawTargets = entries[pattern];
    if (
      !aliasIsSupported(pattern) ||
      !Array.isArray(rawTargets) ||
      rawTargets.length === 0 ||
      !rawTargets.every((target) =>
        typeof target === "string" && targetIsSupported(basePath, target)
      )
    ) {
      limitations.add(`${configPath}: a source alias mapping is unsupported or unsafe.`);
      continue;
    }
    const alias: SafeSourceAlias = {
      configPath,
      wildcard: pattern.includes("*"),
    };
    patterns.set(alias, pattern);
    targets.set(alias, [...rawTargets] as string[]);
    aliases.push(alias);
  }
  return aliases;
}

export function aliasPattern(alias: SafeSourceAlias): string | undefined {
  return patterns.get(alias);
}

export function aliasTargets(alias: SafeSourceAlias): readonly string[] {
  return [...(targets.get(alias) ?? [])];
}

export function sourceConfigForPath(
  configs: readonly SourceAliasConfig[],
  sourcePath: string,
): SourceAliasConfig | undefined {
  return [...configs]
    .filter(({ directory }) => inside(directory, sourcePath))
    .sort((left, right) =>
      right.directory.split("/").length - left.directory.split("/").length ||
      left.path.localeCompare(right.path)
    )[0];
}

export async function loadSourceAliasConfigs(
  inventory: FileInventory,
  readFile: (path: string) => Promise<string>,
  options: SourceAliasConfigOptions = {},
): Promise<SourceAliasConfigResult> {
  const maxExtendsDepth = positiveSafeInteger(
    options.maxExtendsDepth ?? DEFAULT_MAX_CONFIG_EXTENDS_DEPTH,
    "maxExtendsDepth",
  );
  const filesByPath = new Map(inventory.files.map((file) => [file.path, file]));
  const primaryCandidates = inventory.files
    .filter(({ path }) => isPrimaryConfig(path))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (primaryCandidates.length === 0) {
    return { status: "not-applicable", configs: [], limitations: [] };
  }

  const limitations = new Set<string>();
  const selectedByDirectory = new Map<string, FileRecord>();
  for (const candidate of primaryCandidates) {
    if (candidate.kind === "symlink") {
      limitations.add(`${candidate.path}: source configuration symlink was not read.`);
      continue;
    }
    const directory = directoryOf(candidate.path);
    const existing = selectedByDirectory.get(directory);
    if (existing === undefined) {
      selectedByDirectory.set(directory, candidate);
      continue;
    }
    const selected = posix.basename(existing.path) === "tsconfig.json" ? existing : candidate;
    selectedByDirectory.set(directory, selected);
    const label = directory === "." ? "." : directory;
    limitations.add(
      `${label}: both tsconfig.json and jsconfig.json apply; tsconfig.json was selected.`,
    );
  }

  const loadOptions = async (
    currentPath: string,
    originPath: string,
    depth: number,
    stack: ReadonlySet<string>,
  ): Promise<ResolvedOptions | undefined> => {
    if (depth > maxExtendsDepth) {
      limitations.add(
        `${originPath}: local source configuration inheritance exceeds the ${maxExtendsDepth}-file depth limit.`,
      );
      return undefined;
    }
    if (stack.has(currentPath)) {
      limitations.add(`${originPath}: local source configuration inheritance contains a cycle.`);
      return undefined;
    }
    const record = filesByPath.get(currentPath);
    if (record?.kind !== "file") {
      limitations.add(`${originPath}: local source configuration inheritance could not be read.`);
      return undefined;
    }

    let contents: string;
    try {
      contents = await readFile(currentPath);
    } catch {
      limitations.add(`${originPath}: source configuration could not be read.`);
      return undefined;
    }
    const errors: ParseError[] = [];
    const parsed = parse(contents, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    const root = objectValue(parsed);
    if (errors.length > 0 || root === undefined) {
      limitations.add(`${originPath}: source configuration could not be parsed.`);
      return undefined;
    }

    let inherited: ResolvedOptions | undefined;
    if (root.extends !== undefined) {
      if (typeof root.extends !== "string" || !root.extends.startsWith(".")) {
        limitations.add(
          `${originPath}: package-based source configuration inheritance is unsupported.`,
        );
      } else {
        let inheritedPath = safeRepositoryPath(directoryOf(currentPath), root.extends);
        if (inheritedPath !== undefined && posix.extname(inheritedPath) === "") {
          inheritedPath = `${inheritedPath}.json`;
        }
        if (inheritedPath === undefined) {
          limitations.add(`${originPath}: local source configuration inheritance is unsafe.`);
        } else {
          inherited = await loadOptions(
            inheritedPath,
            originPath,
            depth + 1,
            new Set([...stack, currentPath]),
          );
        }
      }
    }

    const compilerOptions = objectValue(root.compilerOptions);
    const directory = directoryOf(currentPath);
    let basePath = inherited?.basePath ?? directory;
    if (compilerOptions?.baseUrl !== undefined) {
      if (typeof compilerOptions.baseUrl !== "string") {
        limitations.add(`${originPath}: source configuration baseUrl is invalid.`);
      } else {
        const resolved = safeRepositoryPath(directory, compilerOptions.baseUrl);
        if (resolved === undefined) {
          limitations.add(`${originPath}: source configuration baseUrl is unsupported or unsafe.`);
        } else {
          basePath = resolved;
        }
      }
    }
    const localAliases = createAliases(
      originPath,
      basePath,
      compilerOptions?.paths,
      limitations,
    );
    return {
      basePath,
      aliases: localAliases ?? inherited?.aliases ?? [],
    };
  };

  const configs: SourceAliasConfig[] = [];
  for (const file of [...selectedByDirectory.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    const resolved = await loadOptions(file.path, file.path, 0, new Set());
    if (resolved === undefined) continue;
    configs.push({
      path: file.path,
      directory: directoryOf(file.path),
      basePath: resolved.basePath,
      aliases: [...resolved.aliases],
    });
  }

  return {
    status: limitations.size === 0 ? "completed" : "partial",
    configs,
    limitations: [...limitations].sort(),
  };
}
