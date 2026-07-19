export const MAX_COVERAGE_RECORDS = 200;
export const MAX_LIMITATION_SAMPLE_PATHS = 5;
export const MAX_INLINE_LIMITATIONS = 100;

export interface LimitationGroup {
  readonly reason: string;
  readonly total: number;
  readonly samplePaths: readonly string[];
  readonly omittedPathCount: number;
}

export interface OmittedRecordSummary {
  readonly total: number;
  readonly emitted: number;
  readonly omitted: number;
}

export interface BoundedLimitations {
  readonly limitations: readonly string[];
  readonly groups: readonly LimitationGroup[];
  readonly summary: OmittedRecordSummary;
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function coherentSummary(summary: OmittedRecordSummary): OmittedRecordSummary {
  const total = safeCount(summary.total);
  const omitted = Math.min(safeCount(summary.omitted), total);
  const emitted = Math.min(safeCount(summary.emitted), total - omitted);
  return { total, emitted, omitted };
}

export function saturatingAddCount(left: number, right: number): number {
  const normalizedLeft = safeCount(left);
  const normalizedRight = safeCount(right);
  if (normalizedLeft > Number.MAX_SAFE_INTEGER - normalizedRight) {
    return Number.MAX_SAFE_INTEGER;
  }
  return normalizedLeft + normalizedRight;
}

export function mergeOmittedRecordSummaries(
  left: OmittedRecordSummary | undefined,
  right: OmittedRecordSummary | undefined,
): OmittedRecordSummary | undefined {
  if (left === undefined) return right === undefined ? undefined : coherentSummary(right);
  if (right === undefined) return coherentSummary(left);
  const normalizedLeft = coherentSummary(left);
  const normalizedRight = coherentSummary(right);
  const total = saturatingAddCount(normalizedLeft.total, normalizedRight.total);
  const omitted = Math.min(
    saturatingAddCount(normalizedLeft.omitted, normalizedRight.omitted),
    total,
  );
  const emitted = Math.min(
    saturatingAddCount(normalizedLeft.emitted, normalizedRight.emitted),
    total - omitted,
  );
  return { total, emitted, omitted };
}

export function preserveSummaryWithAdditionalOmissions(
  existing: OmittedRecordSummary | undefined,
  normalized: OmittedRecordSummary,
): OmittedRecordSummary | undefined {
  const normalizedSummary = coherentSummary(normalized);
  if (existing === undefined) {
    return normalizedSummary.omitted === 0 ? undefined : normalizedSummary;
  }
  const existingSummary = coherentSummary(existing);
  const additionalMaterialized = Math.max(
    0,
    normalizedSummary.total - existingSummary.emitted,
  );
  const total = saturatingAddCount(existingSummary.total, additionalMaterialized);
  const materialized = saturatingAddCount(
    existingSummary.emitted,
    additionalMaterialized,
  );
  const newlyOmitted = Math.min(normalizedSummary.omitted, materialized);
  const omitted = Math.min(
    saturatingAddCount(existingSummary.omitted, newlyOmitted),
    total,
  );
  const emitted = Math.min(materialized - newlyOmitted, total - omitted);
  return { total, emitted, omitted };
}

const PATH_SCOPED_REASONS = new Set([
  "npm lock ownership is unresolved; missing-lockfile analysis was withheld.",
  "private key matched an inventoried localhost-only test certificate; no finding was emitted.",
  "relative source target is covered by a literal ignore rule and may be generated.",
  "relative source target is declared publication output and may require generation.",
  "relative source target is fixture-controlled.",
  "relative source target was not found in the current inventory.",
  "source syntax could not be parsed.",
  "workspace publication target was not found in the current inventory; the entry may require a build.",
  "workspace source target was not found in the current inventory.",
]);

function pathScoped(value: string): { path: string; reason: string } | undefined {
  const separator = value.indexOf(": ");
  if (separator < 1) return undefined;
  const path = value.slice(0, separator);
  const reason = value.slice(separator + 2);
  const supportedReason = PATH_SCOPED_REASONS.has(reason) ||
    /^(?:node:(?:pnpm|yarn|bun)|python|rust|go|java) dependency metadata is not supported\.$/u
      .test(reason);
  if (!supportedReason) return undefined;
  if (!/^[A-Za-z0-9._@/+: -]+$/u.test(path) || path.includes("..") || path.includes("//")) {
    return undefined;
  }
  return { path, reason };
}

export function boundLimitations(values: readonly string[]): BoundedLimitations {
  const unique = [...new Set(values)].sort();
  const byReason = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const value of unique) {
    const parsed = pathScoped(value);
    if (parsed === undefined) {
      ungrouped.push(value);
      continue;
    }
    const paths = byReason.get(parsed.reason) ?? [];
    paths.push(parsed.path);
    byReason.set(parsed.reason, paths);
  }

  const groups: LimitationGroup[] = [];
  const inline = [...ungrouped];
  for (const [reason, rawPaths] of [...byReason.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const paths = [...new Set(rawPaths)].sort();
    if (paths.length <= MAX_LIMITATION_SAMPLE_PATHS) {
      inline.push(...paths.map((path) => `${path}: ${reason}`));
      continue;
    }
    const samplePaths = paths.slice(0, MAX_LIMITATION_SAMPLE_PATHS);
    groups.push({
      reason,
      total: paths.length,
      samplePaths,
      omittedPathCount: paths.length - samplePaths.length,
    });
  }

  const emittedInline = inline.sort().slice(0, MAX_INLINE_LIMITATIONS);
  const emittedEvidence = emittedInline.length +
    groups.reduce((total, group) => total + group.samplePaths.length, 0);
  const summary: OmittedRecordSummary = {
    total: unique.length,
    emitted: emittedEvidence,
    omitted: Math.max(0, unique.length - emittedEvidence),
  };
  const groupedOmitted = groups.reduce((total, group) => total + group.omittedPathCount, 0);
  const unstructuredOmitted = Math.max(0, summary.omitted - groupedOmitted);
  const limitations = [
    ...emittedInline,
    ...groups.map((group) =>
      `${group.reason} ${group.total} paths observed; ${group.omittedPathCount} paths omitted after deterministic sampling.`
    ),
    ...(unstructuredOmitted > 0
      ? [`${unstructuredOmitted} additional limitations omitted after deterministic sampling.`]
      : []),
  ].sort();
  return { limitations, groups, summary };
}

export function boundRecords<T>(
  values: readonly T[],
  key: (value: T) => string,
  maximum = MAX_COVERAGE_RECORDS,
): { records: readonly T[]; summary: OmittedRecordSummary } {
  const records = [...values].sort((left, right) => key(left).localeCompare(key(right)));
  const emitted = Math.min(records.length, maximum);
  return {
    records: records.slice(0, maximum),
    summary: {
      total: records.length,
      emitted,
      omitted: records.length - emitted,
    },
  };
}
