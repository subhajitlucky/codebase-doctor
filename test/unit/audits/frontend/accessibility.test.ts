import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  analyzeHtmlAccessibility,
  analyzeJsxAccessibility,
  createAccessibilityDoctor,
  isHtmlPath,
  isJsxPath,
} from "../../../../src/audits/frontend/accessibility/doctor.js";
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

describe("JSX accessibility analysis", () => {
  it("flags missing alt, iframe title, html lang, and positive tabIndex", () => {
    const source = [
      "export function Page() {",
      "  return (",
      "    <html>",
      "      <body>",
      "        <img src=\"hero.png\" />",
      "        <img src=\"logo.png\" alt=\"Logo\" />",
      "        <img {...props} />",
      "        <iframe src=\"https://example.invalid\" />",
      "        <iframe src=\"https://example.invalid\" title=\"Embed\" />",
      "        <div tabIndex={1} />",
      "        <div tabIndex={0} />",
      "        <span tabIndex=\"2\" />",
      "      </body>",
      "    </html>",
      "  );",
      "}",
      "",
    ].join("\n");
    const analysis = analyzeJsxAccessibility("app/page.tsx", source, false);

    expect(analysis.findings.map((entry) => entry.ruleId).sort()).toEqual([
      "frontend/accessibility/html-missing-lang",
      "frontend/accessibility/iframe-missing-title",
      "frontend/accessibility/img-missing-alt",
      "frontend/accessibility/positive-tabindex",
      "frontend/accessibility/positive-tabindex",
    ]);
    expect(analysis.findings.every((entry) => entry.severity === "medium")).toBe(true);
  });

  it("accepts spread props as potential providers", () => {
    const analysis = analyzeJsxAccessibility(
      "app/card.tsx",
      "export const Card = (props) => <img src=\"x.png\" {...props} />;\n",
      false,
    );
    expect(analysis.findings).toEqual([]);
  });

  it("reports unparsable JSX as a limitation", () => {
    const analysis = analyzeJsxAccessibility("app/broken.tsx", "export const = <img", false);
    expect(analysis.findings).toEqual([]);
    expect(analysis.limitations[0]).toContain("could not be parsed");
  });
});

describe("HTML accessibility analysis", () => {
  it("flags missing alt and lang while ignoring comments", () => {
    const analysis = analyzeHtmlAccessibility("public/index.html", [
      "<!doctype html>",
      "<html>",
      "  <!-- <img src=\"old.png\"> -->",
      "  <img src=\"hero.png\">",
      "  <img src=\"logo.png\" alt=\"Logo\">",
      "  <iframe src=\"https://example.invalid\"></iframe>",
      "</html>",
      "",
    ].join("\n"), false);

    expect(analysis.findings.map((entry) => entry.ruleId).sort()).toEqual([
      "frontend/accessibility/html-missing-lang",
      "frontend/accessibility/iframe-missing-title",
      "frontend/accessibility/img-missing-alt",
    ]);
  });

  it("accepts a complete document", () => {
    const analysis = analyzeHtmlAccessibility("public/index.html", [
      "<html lang=\"en\">",
      "  <img src=\"hero.png\" alt=\"Hero\">",
      "  <iframe src=\"https://example.invalid\" title=\"Embed\"></iframe>",
      "</html>",
      "",
    ].join("\n"), false);
    expect(analysis.findings).toEqual([]);
  });
});

describe("Accessibility Doctor", () => {
  it("reports not-applicable without renderable sources", async () => {
    const doctor = createAccessibilityDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["src/index.ts"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "frontend/accessibility",
      status: "not-applicable",
    }));
  });

  it("audits JSX and HTML files with completed coverage", async () => {
    const files: Record<string, string> = {
      "app/page.tsx": "<html><body><img src=\"x.png\" /></body></html>\n",
      "public/index.html": "<html lang=\"en\"><head><title>Hi</title></head></html>\n",
    };
    const doctor = createAccessibilityDoctor({
      readFile: async (absolutePath) => {
        const key = Object.keys(files).find((candidate) => absolutePath.endsWith(candidate));
        return Buffer.from(key === undefined ? "" : files[key]!);
      },
    });
    const result = await doctor.diagnose({
      snapshot: snapshotWith(Object.keys(files)),
      allowedCapabilities: new Set(["filesystem:read"]),
    });
    expect(result.findings.map((entry) => entry.ruleId).sort()).toEqual([
      "frontend/accessibility/html-missing-lang",
      "frontend/accessibility/img-missing-alt",
    ]);
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "frontend/accessibility",
      status: "completed",
      filesExamined: 2,
    }));
  });

  it("recognizes accessible file paths", () => {
    expect(isJsxPath("app/page.tsx")).toBe(true);
    expect(isJsxPath("app/page.jsx")).toBe(true);
    expect(isJsxPath("app/page.ts")).toBe(false);
    expect(isHtmlPath("public/index.html")).toBe(true);
    expect(isHtmlPath("public/index.htm")).toBe(true);
  });
});
