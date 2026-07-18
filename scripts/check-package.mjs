import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseNpmPackJson } from "./npm-pack-json.mjs";

const packed = spawnSync(
  "npm",
  ["pack", "--json", "--dry-run", "--ignore-scripts"],
  { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
);

assert.equal(packed.status, 0, packed.stderr || packed.stdout);
const reports = parseNpmPackJson(packed.stdout);
assert.equal(reports.length, 1, "Expected one npm package report.");

const [report] = reports;
assert.equal(report.id, "codebase-doctor@0.1.5");
assert.equal(report.name, "codebase-doctor");
assert.equal(report.version, "0.1.5");

const paths = new Set(report.files.map(({ path }) => path));
const required = [
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "docs/architecture.md",
  ".agents/skills/codebase-doctor/SKILL.md",
  ".agents/skills/codebase-doctor/agents/openai.yaml",
];
for (const path of required) {
  assert(paths.has(path), `Required package file is missing: ${path}`);
}

const forbidden = [
  /^src\//,
  /^test\//,
  /^node_modules\//,
  /^coverage\//,
  /^\.git(?:\/|$)/,
  /^\.env(?:\.|$)/,
  /^scripts\//,
  /^\.github\//,
  /^docs\/plans\/private(?:\/|$)/,
  /(?:^|\/)__pycache__\//,
  /(?:^|\/)\.cache\//,
  /(?:^|\/)\.DS_Store$/,
];
for (const path of paths) {
  assert(!forbidden.some((pattern) => pattern.test(path)), `Forbidden package file included: ${path}`);
}

const declarations = readFileSync(new URL("../dist/index.d.ts", import.meta.url), "utf8");
assert.match(
  declarations,
  /MissingTargetProof/,
  "Public declarations must include the safe missing-target proof type.",
);
assert.match(
  declarations,
  /SourceGraphEdge/,
  "Public declarations must include the safe source graph edge type.",
);
for (const privateName of [
  "impactedSourcePaths",
  "completeImpactedPaths",
  "runDoctors",
  "CommandRunner",
]) {
  assert.doesNotMatch(
    declarations,
    new RegExp(`\\b${privateName}\\b`),
    `Private implementation leaked through package declarations: ${privateName}`,
  );
}

console.log(`Verified ${report.id}: ${paths.size} files, ${report.size} packed bytes.`);
