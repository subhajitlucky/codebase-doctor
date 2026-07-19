export type DrizzleDateEvidenceClass =
  | "direct-date-construction"
  | "immutable-date-binding"
  | "declared-date-type"
  | "date-type-assertion";

export type DrizzleAnalysisLimitationCode =
  | "parse-failure"
  | "analysis-budget-exceeded"
  | "unresolved-interpolation";

export interface DrizzleDateMatch {
  readonly line: number;
  readonly column: number;
  readonly evidenceClass: DrizzleDateEvidenceClass;
}

export interface DrizzleAnalysisLimitation {
  readonly code: DrizzleAnalysisLimitationCode;
  readonly line?: number;
  readonly column?: number;
}

export interface DrizzleRawSqlDateAnalysis {
  readonly status: "completed" | "partial";
  readonly matches: readonly DrizzleDateMatch[];
  readonly limitations: readonly DrizzleAnalysisLimitation[];
}

export interface DrizzleAnalyzerBounds {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxLimitations?: number;
}
