import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  analyzeDockerfile,
  createDockerDoctor,
  isDockerfilePath,
} from "../../../../src/audits/infrastructure/docker/doctor.js";
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

describe("Dockerfile analysis", () => {
  it("flags unpinned and latest base images but accepts tags, digests, and stages", () => {
    const analysis = analyzeDockerfile("Dockerfile", [
      "FROM node AS builder",
      "FROM node:latest AS latest-stage",
      "FROM node:20-alpine",
      "FROM node@sha256:abcdef",
      "FROM builder",
      "FROM ${BASE_IMAGE}",
      "",
    ].join("\n"), false);

    const unpinned = analysis.findings.filter((entry) => entry.ruleId.endsWith("unpinned-base-image"));
    expect(unpinned).toHaveLength(2);
    expect(unpinned.every((entry) => entry.severity === "medium")).toBe(true);
    expect(analysis.limitations.join(" ")).toContain("build argument");
  });

  it("flags remote ADD and accepts local ADD", () => {
    const remote = analyzeDockerfile("Dockerfile", [
      "FROM alpine:3.20",
      "ADD https://example.invalid/tool.tar.gz /usr/local/bin/",
      "",
    ].join("\n"), false);
    expect(remote.findings.map((entry) => entry.ruleId)).toEqual([
      "infrastructure/docker/remote-add",
    ]);

    const local = analyzeDockerfile("Dockerfile", [
      "FROM alpine:3.20",
      "ADD ./app /app",
      "",
    ].join("\n"), false);
    expect(local.findings).toEqual([]);
  });

  it("flags pipe-to-shell installs, including across continuations", () => {
    const analysis = analyzeDockerfile("Dockerfile", [
      "FROM alpine:3.20",
      "RUN curl -fsSL https://example.invalid/install.sh \\",
      "  | sh",
      "RUN wget -qO- https://example.invalid/install.sh | bash",
      "RUN curl -o /tmp/tool https://example.invalid/tool",
      "",
    ].join("\n"), false);
    const pipe = analysis.findings.filter((entry) => entry.ruleId.endsWith("pipe-to-shell"));
    expect(pipe).toHaveLength(2);
    expect(pipe.every((entry) => entry.severity === "high")).toBe(true);
  });

  it("flags world-writable permissions and explicit root users", () => {
    const analysis = analyzeDockerfile("Dockerfile", [
      "FROM alpine:3.20",
      "RUN chmod 777 /app && chmod a+rwx /tmp",
      "USER root",
      "USER 0",
      "USER node",
      "",
    ].join("\n"), false);
    expect(analysis.findings.map((entry) => entry.ruleId).sort()).toEqual([
      "infrastructure/docker/root-user",
      "infrastructure/docker/root-user",
      "infrastructure/docker/world-writable",
    ]);
  });

  it("ignores comments and reports instruction counts", () => {
    const analysis = analyzeDockerfile("Dockerfile", [
      "# FROM node",
      "FROM node:20",
      "# USER root",
      "",
    ].join("\n"), false);
    expect(analysis.findings).toEqual([]);
    expect(analysis.instructionsExamined).toBe(1);
  });

  it("recognizes Dockerfile path variants", () => {
    expect(isDockerfilePath("Dockerfile")).toBe(true);
    expect(isDockerfilePath("docker/Dockerfile")).toBe(true);
    expect(isDockerfilePath("app.dockerfile")).toBe(true);
    expect(isDockerfilePath("docker-compose.yml")).toBe(false);
  });
});

describe("Docker Doctor", () => {
  it("reports not-applicable without Dockerfiles", async () => {
    const doctor = createDockerDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["src/index.ts"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });
    expect(result.findings).toEqual([]);
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "infrastructure/docker",
      status: "not-applicable",
    }));
  });

  it("reports findings and partial coverage for unreadable files", async () => {
    const doctor = createDockerDoctor({
      readFile: async (path) => {
        if (path.endsWith("broken.dockerfile")) throw new Error("denied");
        return Buffer.from("FROM node:latest\nUSER root\n");
      },
    });
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["Dockerfile", "broken.dockerfile"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });
    expect(result.findings.map((entry) => entry.ruleId).sort()).toEqual([
      "infrastructure/docker/root-user",
      "infrastructure/docker/unpinned-base-image",
    ]);
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "infrastructure/docker",
      status: "partial",
    }));
  });
});
