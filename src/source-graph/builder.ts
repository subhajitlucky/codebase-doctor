import type {
  DetectedProject,
  FileInventory,
  ManifestRecord,
} from "../workspace/types.js";
import {
  loadSourceAliasConfigs,
  type SourceAliasConfigOptions,
} from "./config.js";
import { parseSourceImports } from "./parser.js";
import { resolveSourceImport } from "./resolver.js";
import {
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_TOTAL_SOURCE_BYTES,
  selectSourceFiles,
  type SourceFileSelectionOptions,
} from "./selection.js";
import type { SourceGraph, SourceGraphEdge, SourceGraphNode } from "./types.js";

export const DEFAULT_MAX_SOURCE_EDGES = 100_000;

export interface SourceGraphBuildOptions
  extends SourceFileSelectionOptions, SourceAliasConfigOptions {
  readonly maxEdges?: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function projectContains(project: DetectedProject, path: string): boolean {
  return project.root === "." || path === project.root || path.startsWith(`${project.root}/`);
}

function projectDepth(project: DetectedProject): number {
  return project.root === "." ? 0 : project.root.split("/").length;
}

function ownerOf(path: string, projects: readonly DetectedProject[]): string | undefined {
  return [...projects]
    .filter((project) => projectContains(project, path))
    .sort((left, right) =>
      projectDepth(right) - projectDepth(left) || left.id.localeCompare(right.id)
    )[0]?.id;
}

function edgeKey(edge: SourceGraphEdge): string {
  return JSON.stringify([
    edge.importerPath,
    edge.targetPath,
    edge.kind,
    edge.targetExists,
  ]);
}

function compareEdges(left: SourceGraphEdge, right: SourceGraphEdge): number {
  return left.importerPath.localeCompare(right.importerPath) ||
    left.targetPath.localeCompare(right.targetPath) ||
    left.kind.localeCompare(right.kind) ||
    Number(right.targetExists) - Number(left.targetExists);
}

export async function buildSourceGraph(
  inventory: FileInventory,
  manifests: readonly ManifestRecord[],
  projects: readonly DetectedProject[],
  readFile: (path: string) => Promise<string>,
  options: SourceGraphBuildOptions = {},
): Promise<SourceGraph> {
  const maxSourceBytes = positiveSafeInteger(
    options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    "maxSourceBytes",
  );
  const maxTotalSourceBytes = positiveSafeInteger(
    options.maxTotalSourceBytes ?? DEFAULT_MAX_TOTAL_SOURCE_BYTES,
    "maxTotalSourceBytes",
  );
  const maxEdges = positiveSafeInteger(
    options.maxEdges ?? DEFAULT_MAX_SOURCE_EDGES,
    "maxEdges",
  );
  const selection = selectSourceFiles(inventory, { maxSourceBytes, maxTotalSourceBytes });
  if (selection.status === "not-applicable") {
    return {
      status: "not-applicable",
      nodes: [],
      edges: [],
      filesExamined: 0,
      bytesExamined: 0,
      externalBoundaryCount: 0,
      dynamicBoundaryCount: 0,
      limitations: [],
    };
  }

  const config = await loadSourceAliasConfigs(
    inventory,
    readFile,
    options.maxExtendsDepth === undefined
      ? {}
      : { maxExtendsDepth: options.maxExtendsDepth },
  );
  const limitations = new Set([...selection.limitations, ...config.limitations]);
  const nodes: SourceGraphNode[] = selection.files.map(({ path }) => {
    const projectId = ownerOf(path, projects);
    return projectId === undefined ? { path } : { path, projectId };
  });
  const edges = new Map<string, SourceGraphEdge>();
  let filesExamined = 0;
  let bytesExamined = 0;
  let externalBoundaryCount = 0;
  let dynamicBoundaryCount = 0;

  sourceFiles:
  for (const file of selection.files) {
    let source: string;
    try {
      source = await readFile(file.path);
    } catch {
      limitations.add(`${file.path}: source file could not be read.`);
      continue;
    }
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (sourceBytes > maxSourceBytes) {
      limitations.add(
        `${file.path}: source file exceeds the ${maxSourceBytes}-byte per-file limit after reading.`,
      );
      continue;
    }
    if (bytesExamined + sourceBytes > maxTotalSourceBytes) {
      limitations.add(
        `Source graph stopped at the ${maxTotalSourceBytes}-byte total source limit before ${file.path}.`,
      );
      break;
    }
    filesExamined += 1;
    bytesExamined += sourceBytes;
    const parsed = parseSourceImports(file.path, source);
    for (const limitation of parsed.limitations) limitations.add(limitation);
    dynamicBoundaryCount += parsed.dynamicBoundaryCount;

    for (const reference of parsed.imports) {
      const resolution = resolveSourceImport(file.path, reference, {
        files: inventory.files,
        manifests,
        projects,
        configs: config.configs,
      });
      for (const limitation of resolution.limitations) limitations.add(limitation);
      if (resolution.kind === "external") {
        externalBoundaryCount += 1;
        continue;
      }
      if (resolution.kind === "unsupported") continue;
      const edge: SourceGraphEdge = {
        importerPath: file.path,
        targetPath: resolution.targetPath,
        kind: reference.kind,
        targetExists: resolution.targetExists,
      };
      const key = edgeKey(edge);
      if (edges.has(key)) continue;
      if (edges.size >= maxEdges) {
        limitations.add(`Source graph stopped at the ${maxEdges}-edge internal graph limit.`);
        break sourceFiles;
      }
      edges.set(key, edge);
    }
  }

  return {
    status: limitations.size === 0 ? "completed" : "partial",
    nodes: nodes.sort((left, right) => left.path.localeCompare(right.path)),
    edges: [...edges.values()].sort(compareEdges),
    filesExamined,
    bytesExamined,
    externalBoundaryCount,
    dynamicBoundaryCount,
    limitations: [...limitations].sort(),
  };
}

export async function buildInventoriedSourceGraph(
  inventory: FileInventory,
  manifests: readonly ManifestRecord[],
  projects: readonly DetectedProject[],
  options: SourceGraphBuildOptions = {},
): Promise<SourceGraph> {
  const root = resolve(inventory.root);
  return buildSourceGraph(
    inventory,
    manifests,
    projects,
    async (path) => {
      const target = resolve(root, path);
      const repositoryRelative = relative(root, target);
      if (
        repositoryRelative === ".." ||
        repositoryRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(repositoryRelative)
      ) {
        throw new Error("Inventoried source path escapes the repository.");
      }
      return readFile(target, "utf8");
    },
    options,
  );
}
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
