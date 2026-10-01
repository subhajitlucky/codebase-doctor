import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  analyzeBackendAuth,
  createBackendAuthDoctor,
  isBackendSourcePath,
} from "../../../../src/audits/backend/auth/doctor.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../src/workspace/types.js";

function snapshotWith(paths: readonly string[]): ProjectSnapshot {
  return {
    root: "/repo",
    files: paths.map((path) => ({ path, kind: "file" as const, size: 400 })),
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
  };
}

function ruleIds(source: string, path = "src/server.ts"): string[] {
  return analyzeBackendAuth(path, source, false).findings.map((entry) => entry.ruleId);
}

describe("backend auth analysis", () => {
  it("recognizes JavaScript, TypeScript, and JSX-family source paths only", () => {
    for (const path of [
      "src/a.js",
      "src/a.jsx",
      "src/a.mjs",
      "src/a.cjs",
      "src/a.ts",
      "src/a.tsx",
      "src/a.mts",
      "src/a.cts",
    ]) {
      expect(isBackendSourcePath(path), path).toBe(true);
    }
    for (const path of ["README.md", "src/a.py", "src/a.go", "src/a.sql", "Dockerfile"]) {
      expect(isBackendSourcePath(path), path).toBe(false);
    }
  });

  it("flags a wildcard CORS origin combined with credentials", () => {
    expect(ruleIds([
      'import cors from "cors";',
      'app.use(cors({ origin: "*", credentials: true }));',
    ].join("\n"))).toEqual(["backend/auth/cors-wildcard-origin-with-credentials"]);

    expect(ruleIds([
      'import cors from "cors";',
      "app.use(cors({ origin: true, credentials: true }));",
    ].join("\n"))).toEqual(["backend/auth/cors-wildcard-origin-with-credentials"]);
  });

  it("accepts an explicit origin allowlist and wildcard without credentials", () => {
    expect(ruleIds([
      'import cors from "cors";',
      'app.use(cors({ origin: ["https://app.example.com"], credentials: true }));',
    ].join("\n"))).toEqual([]);

    expect(ruleIds([
      'import cors from "cors";',
      'app.use(cors({ origin: "*" }));',
    ].join("\n"))).toEqual([]);

    expect(ruleIds([
      'import cors from "cors";',
      'app.use(cors({ origin: "https://app.example.com", credentials: true }));',
    ].join("\n"))).toEqual([]);
  });

  it("resolves aliased and CommonJS bindings but never unbound identifiers", () => {
    expect(ruleIds([
      'import myCors from "cors";',
      "app.use(myCors({ origin: \"*\", credentials: true }));",
    ].join("\n"))).toEqual(["backend/auth/cors-wildcard-origin-with-credentials"]);

    expect(ruleIds([
      'const cors = require("cors");',
      'app.use(cors({ origin: "*", credentials: true }));',
    ].join("\n"))).toEqual(["backend/auth/cors-wildcard-origin-with-credentials"]);

    // A local helper that merely shares the name is not evidence about the cors package.
    expect(ruleIds([
      "declare const cors: (options: unknown) => unknown;",
      'app.use(cors({ origin: "*", credentials: true }));',
    ].join("\n"), "src/a.ts")).toEqual([]);
  });

  it("flags a session cookie with an explicitly disabled security flag", () => {
    const findings = analyzeBackendAuth("src/server.ts", [
      'import session from "express-session";',
      "app.use(session({ cookie: { secure: false, httpOnly: true } }));",
    ].join("\n"), false).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("backend/auth/session-cookie-security-disabled");
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.confidence).toBe("high");
    expect(findings[0]?.category).toBe("backend");
  });

  it("accepts a hardened session cookie configuration", () => {
    expect(ruleIds([
      'import session from "express-session";',
      "app.use(session({ cookie: { secure: true, httpOnly: true } }));",
    ].join("\n"))).toEqual([]);

    // No cookie block at all is not evidence of a misconfiguration.
    expect(ruleIds([
      'import session from "express-session";',
      "app.use(session({ secret: process.env.SESSION_SECRET }));",
    ].join("\n"))).toEqual([]);
  });

  it("flags a JWT decode with no verify call in the same file", () => {
    expect(ruleIds([
      'import jwt from "jsonwebtoken";',
      "export const claims = jwt.decode(token);",
    ].join("\n"))).toEqual(["backend/auth/jwt-decode-without-verify"]);

    // The file verifies a token, so the decode is not reported as unverified.
    expect(ruleIds([
      'import jwt from "jsonwebtoken";',
      'export const claims = jwt.decode(jwt.verify(token, secret, { algorithms: ["HS256"] }));',
    ].join("\n"))).toEqual([]);

    expect(ruleIds([
      'import jwt from "jsonwebtoken";',
      'jwt.verify(token, secret, { algorithms: ["HS256"] });',
      "export const claims = jwt.decode(token);",
    ].join("\n"))).toEqual([]);
  });

  it("flags a JWT verify call that does not pin accepted algorithms", () => {
    expect(ruleIds([
      'import jwt from "jsonwebtoken";',
      "export const claims = jwt.verify(token, secret);",
    ].join("\n"))).toEqual(["backend/auth/jwt-verify-algorithm-unrestricted"]);

    expect(ruleIds([
      'import jwt from "jsonwebtoken";',
      'export const claims = jwt.verify(token, secret, { algorithms: ["HS256"] });',
    ].join("\n"))).toEqual([]);

    expect(ruleIds([
      'import { verify as vfy } from "jsonwebtoken";',
      "export const claims = vfy(token, secret);",
    ].join("\n"))).toEqual(["backend/auth/jwt-verify-algorithm-unrestricted"]);
  });

  it("reports statically unresolvable configuration as a limitation, never a finding", () => {
    const options = analyzeBackendAuth("src/server.ts", [
      'import cors from "cors";',
      "app.use(cors(optionsFromEnv));",
    ].join("\n"), false);
    expect(options.findings).toEqual([]);
    expect(options.limitations.join(" ")).toContain("non-literal options expression");

    const cookie = analyzeBackendAuth("src/server.ts", [
      'import session from "express-session";',
      "app.use(session({ cookie: { secure: secureFlag } }));",
    ].join("\n"), false);
    expect(cookie.findings).toEqual([]);
    expect(cookie.limitations.join(" ")).toContain("session cookie flags");

    const spread = analyzeBackendAuth("src/server.ts", [
      'import cors from "cors";',
      "app.use(cors({ ...shared, credentials: true }));",
    ].join("\n"), false);
    expect(spread.findings).toEqual([]);
    expect(spread.limitations.join(" ")).toContain("could not be resolved statically");
  });

  it("keeps a stable fingerprint, withheld literal evidence, and a rerun command", () => {
    const source = [
      'import cors from "cors";',
      'app.use(cors({ origin: "*", credentials: true }));',
    ].join("\n");
    const first = analyzeBackendAuth("src/server.ts", source, false).findings[0];
    const second = analyzeBackendAuth("src/server.ts", source, false).findings[0];

    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(first?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    // The configured origin literal never enters the evidence record.
    expect(JSON.stringify(first)).not.toContain("*");
    expect(first?.verification?.command).toBe("codebase-doctor audit . --format json");
    expect(first?.verification?.expected).toContain("backend/auth");
    expect(first?.verification?.expected).toContain("coverage completed");
  });

  it("targets the changed-scope verification command when auditing changed files", () => {
    const findings = analyzeBackendAuth("src/server.ts", [
      'import cors from "cors";',
      'app.use(cors({ origin: "*", credentials: true }));',
    ].join("\n"), true).findings;

    expect(findings[0]?.verification?.command).toBe("codebase-doctor audit . --changed --format json");
  });

  it("parses a TypeScript generic arrow in a .ts file as code, not JSX", () => {
    // With the JSX plugin enabled on a .ts path, this reads as a JSX element and
    // fails to parse, which would downgrade real backend coverage to partial.
    const analysis = analyzeBackendAuth("src/generic.ts", [
      "const reversed = <T>(items: T[] | undefined) => [...(items ?? [])].reverse();",
    ].join("\n"), false);
    expect(analysis.limitations).toEqual([]);
  });

  it("still parses JSX in a .tsx file", () => {
    const analysis = analyzeBackendAuth("src/view.tsx", [
      "export const Panel = () => <section data-testid=\"panel\">ok</section>;",
    ].join("\n"), false);
    expect(analysis.limitations).toEqual([]);
  });

  it("records a parse limitation instead of failing on unparseable source", () => {
    const analysis = analyzeBackendAuth("src/broken.ts", "const = = =;", false);
    expect(analysis.findings).toEqual([]);
    expect(analysis.limitations).toEqual(["src/broken.ts: backend source could not be parsed."]);
  });
});

describe("backend auth doctor", () => {
  it("exposes only filesystem read and reports a not-applicable module with no sources", async () => {
    const doctor = createBackendAuthDoctor();
    expect(doctor.id).toBe("backend/auth");
    expect(doctor.capabilities).toEqual(["filesystem:read"]);

    const result = await doctor.diagnose({
      snapshot: snapshotWith(["README.md", "docs/architecture.md"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.status).toBe("completed");
    expect(result.findings).toEqual([]);
    expect(result.coverage?.[0]).toMatchObject({
      moduleId: "backend/auth",
      status: "not-applicable",
      filesExamined: 0,
    });
  });

  it("analyzes inventoried sources and completes coverage when everything resolves", async () => {
    const contents: Record<string, string> = {
      "src/unsafe.ts": [
        'import cors from "cors";',
        'app.use(cors({ origin: "*", credentials: true }));',
      ].join("\n"),
      "src/safe.ts": [
        'import cors from "cors";',
        'app.use(cors({ origin: "https://app.example.com", credentials: true }));',
      ].join("\n"),
    };
    const doctor = createBackendAuthDoctor({
      // The doctor joins the snapshot root with each relative path.
      readFile: async (absolutePath) => Buffer.from(
        contents[absolutePath.replace(/^\/repo\//u, "")] ?? "",
      ),
    });

    const result = await doctor.diagnose({
      snapshot: snapshotWith(Object.keys(contents)),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.status).toBe("completed");
    expect(result.findings.map((entry) => entry.ruleId)).toEqual([
      "backend/auth/cors-wildcard-origin-with-credentials",
    ]);
    expect(result.coverage?.[0]).toMatchObject({
      moduleId: "backend/auth",
      status: "completed",
      filesExamined: 2,
      limitations: [],
    });
  });

  it("degrades to partial coverage when a file cannot be read", async () => {
    const doctor = createBackendAuthDoctor({
      readFile: async () => {
        throw new Error("EACCES");
      },
    });

    const result = await doctor.diagnose({
      snapshot: snapshotWith(["src/unsafe.ts"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.status).toBe("completed");
    expect(result.findings).toEqual([]);
    expect(result.coverage?.[0]?.status).toBe("partial");
    expect(result.coverage?.[0]?.limitations.join(" ")).toContain("could not be read");
  });

  it("bounds total content and records a limitation when the limit is reached", async () => {
    const bounded = createBackendAuthDoctor({
      maxTotalBytes: 10,
      readFile: async () => Buffer.from("const a = 1;"),
    });

    const result = await bounded.diagnose({
      snapshot: snapshotWith(["src/a.ts", "src/b.ts"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.coverage?.[0]?.limitations.join(" ")).toContain("total content limit");
  });
});