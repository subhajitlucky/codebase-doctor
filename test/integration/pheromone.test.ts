import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../src/core/doctor.js";
import { createFingerprint, type Finding } from "../../src/core/findings.js";
import { normalizeScanResult } from "../../src/core/normalize.js";
import {
  buildPheromone,
  mergePheromones,
  serializePheromone,
  verifyPheromone,
} from "../../src/pheromones/pheromone.js";
import { fullAuditScope } from "../../src/scope/planner.js";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
} from "../helpers/temp-project.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];
const TOKEN = "ghp_7Qm2Xv9Kd4Rn8Ts3Lw6Yp1Bc5";

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

function finding(ruleId: string, severity: Finding["severity"], path: string): Finding {
  return {
    ruleId,
    doctorId: "fixture",
    severity,
    confidence: "high",
    category: "test",
    title: ruleId,
    message: `${ruleId} at ${path}`,
    location: { path },
    evidence: [{ type: "observation", detail: ruleId }],
    fingerprint: createFingerprint({ doctorId: "fixture", ruleId, location: { path }, identity: ruleId }),
  };
}

function result(): ReturnType<typeof normalizeScanResult> {
  const registered: RegisteredDoctorResult = {
    doctorId: "fixture",
    result: {
      status: "completed",
      durationMs: 0,
      findings: [
        finding("security/secrets/provider-token", "high", "src/secret-config.ts"),
        finding("security/secrets/provider-token", "high", "src/other-secret.ts"),
        finding("repository/no-visible-tests", "info", "src/index.ts"),
      ],
    } satisfies DoctorResult,
  };
  return normalizeScanResult("/private/repo-name", [], fullAuditScope(), [registered]);
}

describe("pheromone signals", () => {
  it("emits rules and counts without paths, fingerprints, or repo names", () => {
    const signal = buildPheromone(result(), { emittedAt: new Date("2026-10-09T00:00:00Z") });
    const serialized = serializePheromone(signal);

    expect(signal.patterns).toEqual([
      { ruleId: "repository/no-visible-tests", severity: "info", count: 1 },
      { ruleId: "security/secrets/provider-token", severity: "high", count: 2 },
    ]);
    expect(serialized).not.toContain("src/");
    expect(serialized).not.toContain("fingerprint");
    expect(serialized).not.toContain("repo-name");
    expect(serialized).not.toContain(TOKEN);
  });

  it("signs and verifies, and detects tampering", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signal = buildPheromone(result(), {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });

    expect(signal.signature?.algorithm).toBe("ed25519");
    expect(verifyPheromone(signal).valid).toBe(true);
    expect(verifyPheromone({ ...signal, scope: { ...signal.scope, score: 100 } }).valid).toBe(false);
  });

  it("merges verified signals and enforces k-anonymity", () => {
    const first = buildPheromone(result());
    const second = buildPheromone(result());
    const merged = mergePheromones([first, second], { minSignals: 1 });

    expect(merged.index?.signals).toEqual({ total: 2, verified: 2, rejected: 0 });
    expect(merged.index?.patterns[0]).toMatchObject({
      ruleId: "security/secrets/provider-token",
      signals: 2,
      occurrences: 4,
    });

    const anonymous = mergePheromones([first], { minSignals: 3 });
    expect(anonymous.index?.patterns).toEqual([]);
  });

  it("fails closed on invalid signals unless allowed", () => {
    const signal = buildPheromone(result());
    const tampered = { ...signal, scope: { ...signal.scope, score: 100 } };

    const strict = mergePheromones([tampered, signal]);
    expect(strict.index).toBeUndefined();
    expect(strict.rejected).toHaveLength(1);

    const lenient = mergePheromones([tampered, signal], { allowInvalid: true });
    expect(lenient.index?.signals).toEqual({ total: 2, verified: 1, rejected: 1 });
  });
});

describe("pheromone CLI", () => {
  it("emits a signal from an audit and merges signals into an index", async () => {
    const root = await createTempProject("codebase-doctor-pheromone-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, {
      "src/config.ts": `export const apiKey = "${TOKEN}";\n`,
    });
    const workdir = mkdtempSync(join(tmpdir(), "codebase-doctor-pheromone-work-"));
    temporaryRoots.push(workdir);
    const signalPath = join(workdir, "signal.json");

    const audit = cli(["audit", root, "--fail-on", "none", "--pheromone", signalPath]);
    expect(audit.status).toBe(0);
    expect(audit.stderr).toContain("pheromone signal written");

    const merge = cli(["pheromone", "merge", signalPath, signalPath, "--json"]);
    expect(merge.status).toBe(0);
    const index = JSON.parse(merge.stdout) as {
      patterns: { ruleId: string; signals: number }[];
      signals: { verified: number };
    };
    expect(index.signals.verified).toBe(2);
    expect(index.patterns).toContainEqual(
      expect.objectContaining({ ruleId: "security/secrets/provider-token", signals: 2 }),
    );
  }, 60_000);

  it("fails closed when a signal is tampered", async () => {
    const root = await createTempProject("codebase-doctor-pheromone-tamper-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, {
      "src/index.ts": "export const value = 1;\n",
    });
    const workdir = mkdtempSync(join(tmpdir(), "codebase-doctor-pheromone-work-"));
    temporaryRoots.push(workdir);
    const signalPath = join(workdir, "signal.json");

    cli(["audit", root, "--fail-on", "none", "--pheromone", signalPath]);
    const signal = JSON.parse(readFileSync(signalPath, "utf8")) as { scope: { score: number } };
    signal.scope.score = 100;
    writeFileSync(signalPath, JSON.stringify(signal), "utf8");

    const merge = cli(["pheromone", "merge", signalPath]);
    expect(merge.status).toBe(2);
    expect(merge.stderr).toContain("digest mismatch");
  }, 60_000);
});
