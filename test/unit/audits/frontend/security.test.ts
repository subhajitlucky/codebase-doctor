import { describe, expect, it } from "vitest";
import { analyzeJsxSecurity } from "../../../../src/audits/frontend/security/doctor.js";

describe("frontend/security JSX analysis", () => {
  it("flags dynamic HTML without a provable sanitizer", () => {
    const analysis = analyzeJsxSecurity(
      "page.tsx",
      [
        "export function Page({ html }: { html: string }) {",
        "  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
        "}",
        "",
      ].join("\n"),
      false,
    );

    expect(analysis.findings.map(({ ruleId }) => ruleId)).toEqual([
      "frontend/security/dangerously-set-inner-html",
    ]);
    expect(analysis.findings[0]).toMatchObject({ severity: "medium", confidence: "high" });
  });

  it("accepts static literals and explicit sanitizer calls", () => {
    const analysis = analyzeJsxSecurity(
      "page.tsx",
      [
        'import DOMPurify from "dompurify";',
        "export function A() {",
        '  return <div dangerouslySetInnerHTML={{ __html: "<b>static</b>" }} />;',
        "}",
        "export function B({ html }: { html: string }) {",
        "  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;",
        "}",
        "export function C({ html }: { html: string }) {",
        "  return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;",
        "}",
        "",
      ].join("\n"),
      false,
    );

    expect(analysis.findings).toEqual([]);
    expect(analysis.limitations).toEqual([]);
  });

  it("suppresses spread props instead of guessing", () => {
    const analysis = analyzeJsxSecurity(
      "page.tsx",
      [
        "export function Page(props: object) {",
        "  return <div {...props} dangerouslySetInnerHTML={{ __html: props.html }} />;",
        "}",
        "",
      ].join("\n"),
      false,
    );

    expect(analysis.findings).toEqual([]);
  });

  it("reports unresolvable shapes and unparseable sources as limitations", () => {
    const shape = analyzeJsxSecurity(
      "page.tsx",
      [
        "export function Page({ html }: { html: object }) {",
        "  return <div dangerouslySetInnerHTML={html} />;",
        "}",
        "",
      ].join("\n"),
      false,
    );
    expect(shape.findings).toEqual([]);
    expect(shape.limitations.join(" ")).toContain("could not be resolved statically");

    const broken = analyzeJsxSecurity("page.tsx", "export function (broken", false);
    expect(broken.findings).toEqual([]);
    expect(broken.limitations.join(" ")).toContain("could not be parsed");
  });
});
