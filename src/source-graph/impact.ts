import type { ChangedPath } from "../scope/types.js";
import { isSupportedSourcePath } from "./selection.js";
import type {
  SourceGraph,
  SourceGraphStatus,
  SourceImpact,
  SourceImpactRecord,
} from "./types.js";

export const DEFAULT_MAX_REPORTED_IMPACTS = 1_000;
export const DEFAULT_MAX_IMPACT_VISITS = 100_000;

export interface SourceImpactOptions {
  readonly maxReportedImpacts?: number;
  readonly maxVisitedFiles?: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function sourceChangePaths(changes: readonly ChangedPath[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    if (isSupportedSourcePath(change.path)) paths.add(change.path);
    if (
      change.status === "renamed" &&
      change.previousPath !== undefined &&
      isSupportedSourcePath(change.previousPath)
    ) {
      paths.add(change.previousPath);
    }
  }
  return [...paths].sort();
}

function graphSummary(
  mode: SourceImpact["mode"],
  graph: SourceGraph,
  status: SourceGraphStatus,
): SourceImpact {
  return {
    mode,
    status,
    graphNodeCount: graph.nodes.length,
    graphEdgeCount: graph.edges.length,
    externalBoundaryCount: graph.externalBoundaryCount,
    dynamicBoundaryCount: graph.dynamicBoundaryCount,
    changedSourcePaths: [],
    impactedFileCount: 0,
    impactedProjectIds: [],
    impacts: [],
    omittedImpactCount: 0,
    limitations: [...graph.limitations].sort(),
  };
}

export function planSourceImpact(
  mode: SourceImpact["mode"],
  changes: readonly ChangedPath[],
  graph: SourceGraph,
  options: SourceImpactOptions = {},
): SourceImpact {
  const maxReportedImpacts = positiveSafeInteger(
    options.maxReportedImpacts ?? DEFAULT_MAX_REPORTED_IMPACTS,
    "maxReportedImpacts",
  );
  const maxVisitedFiles = positiveSafeInteger(
    options.maxVisitedFiles ?? DEFAULT_MAX_IMPACT_VISITS,
    "maxVisitedFiles",
  );
  if (mode === "full") return graphSummary("full", graph, graph.status);

  const roots = sourceChangePaths(changes);
  if (graph.status === "not-applicable") {
    return graphSummary("changed", graph, "not-applicable");
  }
  if (roots.length === 0 && graph.status !== "partial") {
    return graphSummary("changed", graph, "not-selected");
  }

  const reverse = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const importers = reverse.get(edge.targetPath) ?? new Set<string>();
    importers.add(edge.importerPath);
    reverse.set(edge.targetPath, importers);
  }
  const projectByPath = new Map(graph.nodes.flatMap((node) =>
    node.projectId === undefined ? [] : [[node.path, node.projectId] as const]
  ));
  const rootSet = new Set(roots);
  const pathsByFile = new Map<string, readonly string[]>(
    roots.map((root) => [root, [root] as const]),
  );
  const impacted = new Map<string, readonly string[]>();
  const queue = [...roots];
  const limitations = new Set(graph.limitations);
  let traversalLimited = false;

  for (let index = 0; index < queue.length && !traversalLimited; index += 1) {
    const target = queue[index];
    if (target === undefined) continue;
    const targetPath = pathsByFile.get(target);
    if (targetPath === undefined) continue;
    const importers = [...(reverse.get(target) ?? [])].sort();
    for (const importer of importers) {
      if (pathsByFile.has(importer)) continue;
      if (impacted.size >= maxVisitedFiles) {
        limitations.add(`Source impact stopped at the ${maxVisitedFiles}-file traversal limit.`);
        traversalLimited = true;
        break;
      }
      const dependencyPath = [...targetPath, importer];
      pathsByFile.set(importer, dependencyPath);
      queue.push(importer);
      if (!rootSet.has(importer)) impacted.set(importer, dependencyPath);
    }
  }

  const allRecords: SourceImpactRecord[] = [...impacted.entries()]
    .map(([path, dependencyPath]): SourceImpactRecord => {
      const projectId = projectByPath.get(path);
      return projectId === undefined
        ? { path, dependencyPath: [...dependencyPath] }
        : { path, projectId, dependencyPath: [...dependencyPath] };
    })
    .sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.dependencyPath.join("\0").localeCompare(right.dependencyPath.join("\0"))
    );
  const impacts = allRecords.slice(0, maxReportedImpacts);
  const impactedProjectIds = [...new Set(
    allRecords.flatMap(({ projectId }) => projectId === undefined ? [] : [projectId]),
  )].sort();
  const status: SourceGraphStatus = graph.status === "partial" || traversalLimited
    ? "partial"
    : roots.length === 0 ? "not-selected" : "completed";

  return {
    mode: "changed",
    status,
    graphNodeCount: graph.nodes.length,
    graphEdgeCount: graph.edges.length,
    externalBoundaryCount: graph.externalBoundaryCount,
    dynamicBoundaryCount: graph.dynamicBoundaryCount,
    changedSourcePaths: roots,
    impactedFileCount: allRecords.length,
    impactedProjectIds,
    impacts,
    omittedImpactCount: allRecords.length - impacts.length,
    limitations: [...limitations].sort(),
  };
}
