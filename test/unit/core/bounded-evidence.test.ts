import { describe, expect, it } from "vitest";
import {
  MAX_COVERAGE_RECORDS,
  MAX_LIMITATION_SAMPLE_PATHS,
  boundLimitations,
  boundRecords,
  preserveSummaryWithAdditionalOmissions,
} from "../../../src/core/bounded-evidence.js";

const REASONS = [
  "relative source target is declared publication output and may require generation.",
  "relative source target is fixture-controlled.",
  "npm lock ownership is unresolved; missing-lockfile analysis was withheld.",
] as const;

function limitations(): string[] {
  return Array.from({ length: 1_500 }, (_, index) =>
    `packages/pkg-${index.toString().padStart(4, "0")}/index.ts: ${REASONS[index % REASONS.length]}`
  );
}

describe("bounded report evidence", () => {
  it("groups path-scoped limitations with deterministic samples and exact totals", () => {
    const forward = boundLimitations(limitations());
    const reverse = boundLimitations([...limitations()].reverse());

    expect(reverse).toEqual(forward);
    expect(forward.summary).toEqual({ total: 1_500, emitted: 15, omitted: 1_485 });
    expect(forward.groups).toHaveLength(3);
    expect(forward.groups).toEqual(expect.arrayContaining(REASONS.map((reason) => ({
      reason,
      total: 500,
      samplePaths: expect.any(Array),
      omittedPathCount: 500 - MAX_LIMITATION_SAMPLE_PATHS,
    }))));
    for (const group of forward.groups) {
      expect(group.samplePaths).toHaveLength(MAX_LIMITATION_SAMPLE_PATHS);
    }
    expect(forward.limitations.length).toBeLessThan(10);
  });

  it("caps records deterministically without losing exact counts", () => {
    const records = Array.from({ length: 1_500 }, (_, index) => ({
      scope: `project-${index.toString().padStart(4, "0")}`,
    }));
    const forward = boundRecords(records, ({ scope }) => scope);
    const reverse = boundRecords([...records].reverse(), ({ scope }) => scope);

    expect(reverse).toEqual(forward);
    expect(forward.records).toHaveLength(MAX_COVERAGE_RECORDS);
    expect(forward.summary).toEqual({
      total: 1_500,
      emitted: MAX_COVERAGE_RECORDS,
      omitted: 1_500 - MAX_COVERAGE_RECORDS,
    });
  });

  it.each([
    [
      { total: 120, emitted: 120, omitted: 0 },
      { total: 120, emitted: 100, omitted: 20 },
      { total: 120, emitted: 100, omitted: 20 },
    ],
    [
      { total: 240, emitted: 200, omitted: 40 },
      { total: 200, emitted: 100, omitted: 100 },
      { total: 240, emitted: 100, omitted: 140 },
    ],
    [
      { total: 10, emitted: 8, omitted: 2 },
      { total: 12, emitted: 9, omitted: 3 },
      { total: 14, emitted: 9, omitted: 5 },
    ],
  ])("reclassifies bounded evidence without inventing totals", (existing, normalized, expected) => {
    expect(preserveSummaryWithAdditionalOmissions(existing, normalized)).toEqual(expected);
  });
});
