import { describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../../src/core/doctor.js";
import { createFingerprint, type Finding } from "../../../src/core/findings.js";
import { normalizeScanResult, type ScanResult } from "../../../src/core/normalize.js";
import { renderJsonReport } from "../../../src/reporters/json.js";
import {
  renderScoreLine,
  renderScoreOutput,
  scoreBadgeUrl,
} from "../../../src/reporters/score.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function finding(): Finding {
  return {
    ruleId: "fixture/high",
    doctorId: "fixture",
    severity: "high",
    confidence: "high",
    category: "test",
    title: "High finding",
    message: "High message",
    evidence: [{ type: "observation", detail: "high" }],
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId: "fixture/high",
      identity: "high",
    }),
  };
}

function result(): ScanResult {
  const registered: RegisteredDoctorResult = {
    doctorId: "fixture",
    result: {
      status: "completed",
      durationMs: 0,
      findings: [finding()],
    } satisfies DoctorResult,
  };
  return normalizeScanResult("/repo", [], fullAuditScope(), [registered]);
}

describe("score reporters", () => {
  it("prints one deterministic score line", () => {
    expect(renderScoreLine(result())).toBe("Repo Health: 90/100\n");
  });

  it("builds a shields.io badge URL with the band color", () => {
    expect(scoreBadgeUrl(result())).toBe(
      "https://img.shields.io/badge/Repo%20Health-90%2F100-green",
    );
  });

  it("renders score and badge together and nothing when unselected", () => {
    expect(renderScoreOutput(result(), {})).toBeUndefined();
    expect(renderScoreOutput(result(), { score: true })).toBe("Repo Health: 90/100\n");
    expect(renderScoreOutput(result(), { badge: true })).toBe(
      "https://img.shields.io/badge/Repo%20Health-90%2F100-green\n",
    );
    expect(renderScoreOutput(result(), { score: true, badge: true })).toBe(
      "Repo Health: 90/100\nhttps://img.shields.io/badge/Repo%20Health-90%2F100-green\n",
    );
  });

  it("always includes the score in JSON output", () => {
    const parsed = JSON.parse(renderJsonReport(result())) as { score: { value: number } };
    expect(parsed.score.value).toBe(90);
  });
});
