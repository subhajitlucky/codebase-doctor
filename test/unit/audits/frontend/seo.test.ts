import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  analyzeHtmlSeo,
  createSeoDoctor,
} from "../../../../src/audits/frontend/seo/doctor.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../src/workspace/types.js";

function snapshotWith(paths: readonly string[]): ProjectSnapshot {
  return {
    root: "/repo",
    files: paths.map((path) => ({ path, kind: "file" as const, size: 500 })),
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
  };
}

describe("HTML SEO analysis", () => {
  it("flags missing title and meta description", () => {
    const analysis = analyzeHtmlSeo("public/index.html", [
      "<!doctype html>",
      "<html lang=\"en\">",
      "  <head></head>",
      "  <body></body>",
      "</html>",
      "",
    ].join("\n"), false);

    expect(analysis.findings.map((entry) => entry.ruleId).sort()).toEqual([
      "frontend/seo/missing-meta-description",
      "frontend/seo/missing-title",
    ]);
    expect(analysis.findings.find((entry) => entry.ruleId.endsWith("missing-title"))?.severity)
      .toBe("medium");
    expect(analysis.findings.find((entry) => entry.ruleId.endsWith("missing-meta-description"))?.severity)
      .toBe("low");
  });

  it("accepts a complete document and ignores comment decoys", () => {
    const analysis = analyzeHtmlSeo("public/index.html", [
      "<html lang=\"en\">",
      "  <head>",
      "    <!-- <title></title> -->",
      "    <title>Meaningful title</title>",
      "    <meta name=\"description\" content=\"A concise summary.\">",
      "  </head>",
      "</html>",
      "",
    ].join("\n"), false);
    expect(analysis.findings).toEqual([]);
  });

  it("flags an empty title and single-quoted empty description", () => {
    const analysis = analyzeHtmlSeo("about.html", [
      "<html lang=\"en\">",
      "  <head>",
      "    <title>   </title>",
      "    <meta name='description' content=''>",
      "  </head>",
      "</html>",
      "",
    ].join("\n"), false);
    expect(analysis.findings.map((entry) => entry.ruleId).sort()).toEqual([
      "frontend/seo/missing-meta-description",
      "frontend/seo/missing-title",
    ]);
  });
});

describe("SEO Doctor", () => {
  it("reports not-applicable without HTML documents", async () => {
    const doctor = createSeoDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["app/page.tsx"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "frontend/seo",
      status: "not-applicable",
    }));
  });

  it("audits HTML documents with completed coverage", async () => {
    const doctor = createSeoDoctor({
      readFile: async () => Buffer.from("<html lang=\"en\"><head><title>Hi</title><meta name=\"description\" content=\"d\"></head></html>"),
    });
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["public/index.html"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });
    expect(result.findings).toEqual([]);
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "frontend/seo",
      status: "completed",
      filesExamined: 1,
      statementsExamined: 1,
    }));
  });
});
