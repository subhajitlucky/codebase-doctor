import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../src/core/doctor.js";
import type { DomainCoverage } from "../../src/core/domain-coverage.js";
import { createFingerprint, type Finding } from "../../src/core/findings.js";
import { normalizeScanResult } from "../../src/core/normalize.js";
import { IntentError, parseIntents } from "../../src/intent/parse.js";
import { buildIntentReport, evaluateIntent } from "../../src/intent/verify.js";
import { fullAuditScope } from "../../src/scope/planner.js";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
} from "../helpers/temp-project.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];
const TOKEN = "ghp_" + "7Qm2Xv9Kd4Rn8Ts3Lw6Yp1Bc5";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 },
  );
}

function finding(ruleId: string): Finding {
  return {
    ruleId,
    doctorId: "fixture",
    severity: "high",
    confidence: "high",
    category: "test",
    title: ruleId,
    message: ruleId,
    location: { path: "src/config.ts", line: 1 },
    evidence: [{ type: "observation", detail: ruleId }],
    fingerprint: createFingerprint({ doctorId: "fixture", ruleId, location: { path: "src/config.ts" }, identity: ruleId }),
  };
}

const partialSecurity: DomainCoverage[] = [
  {
    domain: "security",
    applicability: "detected",
    status: "partial",
    coverageComplete: false,
    evidence: [],
    modules: [],
    limitations: [],
  },
  {
    domain: "database",
    applicability: "unknown",
    status: "skipped",
    coverageComplete: false,
    evidence: [],
    modules: [],
    limitations: [],
  },
];

function result(findings: Finding[] = [], domains: DomainCoverage[] = []): ReturnType<typeof normalizeScanResult> {
  const registered: RegisteredDoctorResult = {
    doctorId: "fixture",
    result: { status: "completed", durationMs: 0, findings } satisfies DoctorResult,
  };
  return normalizeScanResult("/repo", [], fullAuditScope(), [registered], [], domains);
}

describe("intent parsing", () => {
  it("parses JSON documents and markdown intent blocks", () => {
    const json = parseIntents(
      JSON.stringify({
        intentVersion: "1",
        claims: [{ id: "a", kind: "coverage-complete" }],
      }),
    );
    expect(json.claims).toEqual([{ id: "a", kind: "coverage-complete" }]);

    const markdown = parseIntents(
      "Some prose that must not be interpreted.\n\n```intent\n" +
      JSON.stringify({ intentVersion: "1", claims: [{ id: "b", kind: "score-at-least", value: 80 }] }) +
      "\n```\nMore prose.\n",
    );
    expect(markdown.claims).toEqual([{ id: "b", kind: "score-at-least", value: 80 }]);
    expect(markdown.unstructuredCharacters).toBeGreaterThan(0);
  });

  it("refuses free text and malformed claims", () => {
    expect(() => parseIntents("just prose, no blocks")).toThrow(IntentError);
    expect(() => parseIntents('{"intentVersion":"1","claims":[]}')).toThrow(/at least one claim/);
    expect(() =>
      parseIntents('{"intentVersion":"1","claims":[{"kind":"rule-absent"}]}')
    ).toThrow(/requires a ruleId/);
  });
});

describe("intent verification", () => {
  it("verifies, violates, and holds undecided with coverage honesty", () => {
    const claims = parseIntents(JSON.stringify({
      intentVersion: "1",
      claims: [
        { id: "absent", kind: "rule-absent", ruleId: "security/secrets/provider-token" },
        { id: "present", kind: "rule-present", ruleId: "security/secrets/provider-token" },
        { id: "db", kind: "rule-absent", ruleId: "database/sql-rls/public-unconditional-read" },
        { id: "score", kind: "score-at-least", value: 50 },
        { id: "coverage", kind: "coverage-complete" },
      ],
    })).claims;

    const withSecret = evaluateIntent(
      claims,
      result([finding("security/secrets/provider-token")], partialSecurity),
    );
    expect(withSecret[0]).toMatchObject({ status: "violated", evidence: ["src/config.ts:1"] });
    expect(withSecret[1]).toMatchObject({ status: "verified" });
    expect(withSecret[2]).toMatchObject({ status: "undecided" });
    expect(withSecret[3]).toMatchObject({ status: "verified" });
    expect(withSecret[4]).toMatchObject({ status: "violated" });

    const clean = evaluateIntent(claims, result([], [{
      domain: "security",
      applicability: "detected",
      status: "completed",
      coverageComplete: true,
      evidence: [],
      modules: [],
      limitations: [],
    }]));
    expect(clean[0]).toMatchObject({ status: "verified" });
    expect(clean[1]).toMatchObject({ status: "violated" });
    expect(clean[2]).toMatchObject({ status: "undecided" });
    expect(clean[4]).toMatchObject({ status: "verified" });
  });

  it("builds a stable report digest", () => {
    const claims = parseIntents('{"intentVersion":"1","claims":[{"id":"c","kind":"coverage-complete"}]}').claims;
    const results = evaluateIntent(claims, result([], partialSecurity));
    const at = new Date("2026-10-09T00:00:00Z");
    const report = buildIntentReport(results, { path: "/repo", intentSource: "intent.json" }, 0, "test", at);
    expect(report.summary).toEqual({ claims: 1, verified: 0, violated: 1, undecided: 0 });
    expect(report.digest.value).toHaveLength(64);
  });
});

describe("intent CLI", () => {
  it("violates a declared claim with evidence and exits 1", async () => {
    const root = await createTempProject("codebase-doctor-intent-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, {
      "src/config.ts": `export const apiKey = "${TOKEN}";\n`,
    });
    const workdir = mkdtempSync(join(tmpdir(), "codebase-doctor-intent-work-"));
    temporaryRoots.push(workdir);
    const intentPath = join(workdir, "intent.json");
    writeFileSync(intentPath, JSON.stringify({
      intentVersion: "1",
      claims: [
        { id: "no-secrets", kind: "rule-absent", ruleId: "security/secrets/provider-token" },
        { id: "score", kind: "score-at-least", value: 95 },
      ],
    }), "utf8");

    const verify = cli(["intent", "verify", intentPath, root]);
    expect(verify.status).toBe(1);
    expect(verify.stdout).toContain("VIOLATED");
    expect(verify.stdout).toContain("src/config.ts:1");
    expect(verify.stdout).toContain("score 80 < 95");
  }, 60_000);

  it("extracts markdown intent blocks and notes unstructured prose", async () => {
    const root = await createTempProject("codebase-doctor-intent-md-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, { "src/index.ts": "export const value = 1;\n" });
    const workdir = mkdtempSync(join(tmpdir(), "codebase-doctor-intent-work-"));
    temporaryRoots.push(workdir);
    const intentPath = join(workdir, "pr.md");
    writeFileSync(intentPath, [
      "# PR",
      "",
      "The agent says it removed the leak.",
      "",
      "```intent",
      JSON.stringify({
        intentVersion: "1",
        claims: [{ id: "no-secrets", kind: "rule-absent", ruleId: "security/secrets/provider-token" }],
      }),
      "```",
      "",
    ].join("\n"), "utf8");

    const verify = cli(["intent", "verify", intentPath, root, "--json"]);
    const report = JSON.parse(verify.stdout) as {
      summary: { verified: number };
      unstructuredCharacters: number;
    };
    expect(report.summary.verified).toBe(1);
    expect(report.unstructuredCharacters).toBeGreaterThan(0);
  }, 60_000);

  it("reuses a saved report and gates undecided claims with --require-verified", async () => {
    const root = await createTempProject("codebase-doctor-intent-report-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, { "src/index.ts": "export const value = 1;\n" });
    const workdir = mkdtempSync(join(tmpdir(), "codebase-doctor-intent-work-"));
    temporaryRoots.push(workdir);
    const reportPath = join(workdir, "audit.json");
    const intentPath = join(workdir, "intent.json");
    writeFileSync(intentPath, JSON.stringify({
      intentVersion: "1",
      claims: [
        { id: "db", kind: "rule-absent", ruleId: "database/sql-rls/public-unconditional-read" },
      ],
    }), "utf8");

    const audit = cli(["audit", root, "--json", "--fail-on", "none"]);
    expect(audit.status).toBe(0);
    writeFileSync(reportPath, audit.stdout, "utf8");

    const verify = cli(["intent", "verify", intentPath, root, "--report", reportPath, "--json"]);
    expect(verify.status).toBe(0);
    const report = JSON.parse(verify.stdout) as { summary: { undecided: number } };
    expect(report.summary.undecided).toBe(1);

    const strict = cli(["intent", "verify", intentPath, root, "--report", reportPath, "--require-verified"]);
    expect(strict.status).toBe(2);
    expect(strict.stderr).toContain("--require-verified");
  }, 60_000);
});
