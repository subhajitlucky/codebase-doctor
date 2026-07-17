export const SOURCE_IMPORT_KINDS = [
  "static",
  "re-export",
  "type-only",
  "require",
  "dynamic-literal",
] as const;

export type SourceImportKind = (typeof SOURCE_IMPORT_KINDS)[number];

export type SourceGraphStatus =
  | "completed"
  | "partial"
  | "not-applicable"
  | "not-selected";

export interface SourceGraphNode {
  readonly path: string;
  readonly projectId?: string;
}

export interface SourceGraphEdge {
  readonly importerPath: string;
  readonly targetPath: string;
  readonly kind: SourceImportKind;
  readonly targetExists: boolean;
}

export interface SourceGraph {
  readonly status: Exclude<SourceGraphStatus, "not-selected">;
  readonly nodes: readonly SourceGraphNode[];
  readonly edges: readonly SourceGraphEdge[];
  readonly filesExamined: number;
  readonly bytesExamined: number;
  readonly externalBoundaryCount: number;
  readonly dynamicBoundaryCount: number;
  readonly limitations: readonly string[];
}

export interface SourceImpactRecord {
  readonly path: string;
  readonly projectId?: string;
  readonly dependencyPath: readonly string[];
}

export interface SourceImpact {
  readonly mode: "full" | "changed";
  readonly status: SourceGraphStatus;
  readonly graphNodeCount: number;
  readonly graphEdgeCount: number;
  readonly externalBoundaryCount: number;
  readonly dynamicBoundaryCount: number;
  readonly changedSourcePaths: readonly string[];
  readonly impactedFileCount: number;
  readonly impactedProjectIds: readonly string[];
  readonly impacts: readonly SourceImpactRecord[];
  readonly omittedImpactCount: number;
  readonly limitations: readonly string[];
}
