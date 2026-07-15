import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface CodebaseConfig {
  exclude: readonly string[];
}

export class CodebaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodebaseConfigError";
  }
}

export function validateExcludePattern(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.length === 0) {
    throw new CodebaseConfigError("Exclude patterns must not be empty.");
  }
  if (isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    throw new CodebaseConfigError(`Exclude pattern "${pattern}" must be repository-relative.`);
  }
  if (normalized.split("/").includes("..")) {
    throw new CodebaseConfigError(`Exclude pattern "${pattern}" must not escape the repository.`);
  }
  if (normalized.includes("\0")) {
    throw new CodebaseConfigError("Exclude patterns must not contain null bytes.");
  }
  return normalized;
}

export async function loadCodebaseConfig(root: string): Promise<CodebaseConfig> {
  const path = join(root, ".codebase-doctor.json");
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exclude: [] };
    throw new CodebaseConfigError(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new CodebaseConfigError(`${path} must contain valid JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodebaseConfigError(`${path} must contain a JSON object.`);
  }

  const config = value as Record<string, unknown>;
  const unknownKeys = Object.keys(config).filter((key) => key !== "exclude");
  if (unknownKeys.length > 0) {
    throw new CodebaseConfigError(`Unknown configuration key "${unknownKeys[0]}" in ${path}.`);
  }
  const exclude = config.exclude ?? [];
  if (!Array.isArray(exclude) || !exclude.every((entry) => typeof entry === "string")) {
    throw new CodebaseConfigError(`The "exclude" value in ${path} must be an array of strings.`);
  }
  return {
    exclude: exclude.map((pattern) => {
      try {
        return validateExcludePattern(pattern);
      } catch (error) {
        throw new CodebaseConfigError(
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  };
}
