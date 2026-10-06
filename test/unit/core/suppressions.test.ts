import { describe, expect, it } from "vitest";
import {
  applySuppressions,
  parseSuppressionDirectives,
} from "../../../src/core/suppressions.js";
import { createFingerprint, type Finding } from "../../../src/core/findings.js";

function finding(
  ruleId: string,
  path: string,
  line?: number,
  doctorId = "security/secrets",
): Finding {
  return {
    ruleId,
    doctorId,
    severity: "high",
    confidence: "high",
    category: "security",
    title: ruleId,
    message: ruleId,
    ...(line === undefined ? {} : { location: { path, line } }),
    evidence: [{ type: "observation", detail: ruleId }],
    fingerprint: createFingerprint({
      doctorId,
      ruleId,
      ...(line === undefined ? {} : { location: { path, line } }),
      identity: ruleId,
    }),
  };
}

function locatedFinding(ruleId: string, path: string, line: number, doctorId?: string): Finding {
  const base = finding(ruleId, path, line, doctorId ?? "security/secrets");
  return { ...base, location: { path, line } };
}

describe("parseSuppressionDirectives", () => {
  it("parses rule ids with an optional reason", () => {
    const [directive] = parseSuppressionDirectives(
      "// codebase-doctor-ignore: security/secrets/provider-token -- test fixture, rotated",
    );

    expect(directive?.targets).toEqual(["security/secrets/provider-token"]);
    expect(directive?.reason).toBe("test fixture, rotated");
    expect(directive?.line).toBe(1);
  });

  it("supports multiple comma-separated targets and comment styles", () => {
    const directives = parseSuppressionDirectives(
      [
        "# codebase-doctor-ignore: rule/a, rule/b",
        "const x = 1; // codebase-doctor-ignore: security/secrets",
        "no directive here",
        "codebase-doctor-ignore:",
      ].join("\n"),
    );

    expect(directives.map(({ targets }) => targets)).toEqual([
      ["rule/a", "rule/b"],
      ["security/secrets"],
    ]);
    expect(directives.map(({ line }) => line)).toEqual([1, 2]);
  });
});

describe("applySuppressions", () => {
  const readFile = (files: Record<string, string>) =>
    async (absolutePath: string): Promise<Uint8Array> => {
      const content = files[absolutePath];
      if (content === undefined) throw new Error(`missing file ${absolutePath}`);
      return Buffer.from(content, "utf8");
    };

  it("suppresses findings with a directive on the same or previous line", async () => {
    const outcome = await applySuppressions(
      "/repo",
      [
        locatedFinding("security/secrets/provider-token", "a.ts", 2),
        locatedFinding("security/secrets/provider-token", "a.ts", 5),
        locatedFinding("security/secrets/provider-token", "a.ts", 8),
      ],
      {
        readFile: readFile({
          "/repo/a.ts": [
            "// codebase-doctor-ignore: security/secrets/provider-token -- fixture",
            'const one = "x";',
            'const two = "y"; // codebase-doctor-ignore: security/secrets/provider-token',
            'const three = "z";',
            "",
            "",
            "",
            'const four = "w";',
          ].join("\n"),
        }),
      },
    );

    expect(outcome.kept.map(({ location }) => location?.line)).toEqual([5, 8]);
    expect(outcome.suppressed).toHaveLength(1);
    expect(outcome.suppressed[0]).toMatchObject({
      ruleId: "security/secrets/provider-token",
      path: "a.ts",
      directiveLine: 1,
      reason: "fixture",
    });
    expect(outcome.limitations).toEqual([]);
  });

  it("matches doctor ids and wildcard prefixes without hiding other rules", async () => {
    const outcome = await applySuppressions(
      "/repo",
      [
        locatedFinding("source/import-target-missing", "b.ts", 1, "repository/source-integrity"),
        locatedFinding("other/rule", "b.ts", 1, "other"),
        locatedFinding("unrelated/kept", "b.ts", 1, "unrelated"),
      ],
      {
        readFile: readFile({
          "/repo/b.ts": '// codebase-doctor-ignore: repository/source-integrity, other/*',
        }),
      },
    );

    expect(outcome.kept.map(({ ruleId }) => ruleId)).toEqual(["unrelated/kept"]);
    expect(outcome.suppressed.map(({ ruleId }) => ruleId).sort()).toEqual([
      "other/rule",
      "source/import-target-missing",
    ]);
  });

  it("never suppresses findings without a location", async () => {
    const global = finding("some/rule", "nowhere.ts");
    const outcome = await applySuppressions(
      "/repo",
      [global],
      { readFile: readFile({}) },
    );

    expect(outcome.kept).toEqual([global]);
    expect(outcome.suppressed).toEqual([]);
  });

  it("keeps findings and records limitations for unreadable, binary, and oversized files", async () => {
    const outcome = await applySuppressions(
      "/repo",
      [
        locatedFinding("r/a", "missing.ts", 1),
        locatedFinding("r/b", "big.ts", 1),
      ],
      {
        maxFileBytes: 4,
        readFile: readFile({ "/repo/big.ts": "12345" }),
      },
    );

    expect(outcome.kept).toHaveLength(2);
    expect(outcome.suppressed).toEqual([]);
    expect(outcome.limitations.join(" ")).toContain("could not be read");
    expect(outcome.limitations.join(" ")).toContain("suppression size limit");
  });

  it("bounds the number of examined files deterministically", async () => {
    const outcome = await applySuppressions(
      "/repo",
      [locatedFinding("r/a", "b.ts", 1), locatedFinding("r/a", "a.ts", 1)],
      {
        maxFiles: 1,
        readFile: readFile({
          "/repo/a.ts": "// codebase-doctor-ignore: r/a",
          "/repo/b.ts": "// codebase-doctor-ignore: r/a",
        }),
      },
    );

    expect(outcome.suppressed.map(({ path }) => path)).toEqual(["a.ts"]);
    expect(outcome.kept.map(({ location }) => location?.path)).toEqual(["b.ts"]);
    expect(outcome.limitations.join(" ")).toContain("first 1 of 2 files");
  });
});
