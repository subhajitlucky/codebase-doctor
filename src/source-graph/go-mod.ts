import { posix } from "node:path";
import type { FileInventory, DetectedProject } from "../workspace/types.js";

export interface GoModuleInfo {
  readonly root: string;
  readonly modulePath: string;
  readonly hasReplace: boolean;
}

export interface GoModuleLoadResult {
  readonly modules: ReadonlyMap<string, GoModuleInfo>;
  readonly limitations: readonly string[];
}

function stripComment(line: string): string {
  const marker = line.indexOf("//");
  return marker < 0 ? line : line.slice(0, marker);
}

export function parseGoMod(content: string, root: string): GoModuleInfo | undefined {
  let modulePath: string | undefined;
  let hasReplace = false;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;
    if (/^replace\b/u.test(line) || /^replace\s*\(/u.test(line)) hasReplace = true;
    if (modulePath !== undefined) continue;
    const match = /^module\s+(.+)$/u.exec(line);
    const raw = match?.[1]?.trim();
    if (raw === undefined || raw.length === 0) continue;
    const unquoted = raw.startsWith('"') && raw.endsWith('"') && raw.length > 1
      ? raw.slice(1, -1)
      : raw;
    if (unquoted.length > 0 && !/\s/u.test(unquoted)) modulePath = unquoted;
  }
  if (modulePath === undefined) return undefined;
  return { root, modulePath, hasReplace };
}

/**
 * Loads `module` and `replace` evidence from each Go project's go.mod so
 * internal import paths can be resolved deterministically. go.work-only
 * layouts stay limitations because module paths are not declared there.
 */
export async function loadGoModuleInfo(
  inventory: FileInventory,
  projects: readonly DetectedProject[],
  readFile: (path: string) => Promise<string>,
): Promise<GoModuleLoadResult> {
  const modules = new Map<string, GoModuleInfo>();
  const limitations: string[] = [];
  const filesByPath = new Map(inventory.files.map((file) => [file.path, file]));
  const goProjects = projects
    .filter((project) => project.ecosystems.some((ecosystem) => ecosystem.toLowerCase() === "go"))
    .sort((left, right) => left.root.localeCompare(right.root));

  for (const project of goProjects) {
    const goModPath = project.root === "." ? "go.mod" : `${project.root}/go.mod`;
    if (filesByPath.get(goModPath)?.kind !== "file") {
      const goWorkPath = project.root === "." ? "go.work" : `${project.root}/go.work`;
      if (filesByPath.get(goWorkPath)?.kind === "file") {
        limitations.push(
          `${goWorkPath}: Go workspace metadata does not declare a module path; internal import resolution was skipped.`,
        );
      }
      continue;
    }
    let content: string;
    try {
      content = await readFile(goModPath);
    } catch {
      limitations.push(`${goModPath}: Go module metadata could not be read.`);
      continue;
    }
    const module = parseGoMod(content, project.root);
    if (module === undefined) {
      limitations.push(`${goModPath}: Go module path could not be parsed.`);
      continue;
    }
    modules.set(project.root, module);
  }

  return { modules, limitations: limitations.sort() };
}

export function isGoSourcePath(path: string): boolean {
  return posix.extname(path).toLowerCase() === ".go";
}
