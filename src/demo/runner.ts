import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { classifyScanExit, type ScanResult } from "../core/normalize.js";
import { auditCodebase } from "../core/scan.js";
import { renderBriefReport } from "../reporters/brief.js";
import { DEMO_BROKEN_FILES, DEMO_FIXTURE_FILES, DEMO_REPLAY_OUTPUT, type DemoFile } from "./fixture.js";

const execFileAsync = promisify(execFile);
const DEMO_TIMEOUT_MS = 120_000;
const MAX_IMPACT_LINES = 3;

export interface DemoOutcome {
  output: string;
  live: boolean;
  exitCode: 0 | 1 | 2;
}

export interface DemoHooks {
  isGitAvailable: () => Promise<boolean>;
  runLiveDemo: () => Promise<DemoOutcome>;
}

/**
 * Zero-config demo: builds a disposable git fixture with a tracked secret and
 * a broken import, applies one "agent edit", audits the change with the real
 * pipeline, and shows the blast radius. Everything happens in a temp
 * directory that is always removed. Falls back to a recorded run when git is
 * unavailable.
 */
export async function runDemo(hooks: Partial<DemoHooks> = {}): Promise<DemoOutcome> {
  const isGitAvailable = hooks.isGitAvailable ?? gitAvailable;
  const runLiveDemo = hooks.runLiveDemo ?? liveDemo;

  if (!(await isGitAvailable())) {
    return { output: replayOutput("Git was not found on this machine."), live: false, exitCode: 0 };
  }

  try {
    return await runLiveDemo();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      output: replayOutput(`The live demo could not run: ${message}`),
      live: false,
      exitCode: 0,
    };
  }
}

export function renderDemoOutput(result: ScanResult): string {
  const impacts = (result.sourceImpact?.impacts ?? [])
    .slice(0, MAX_IMPACT_LINES)
    .map((record) => record.dependencyPath.join(" → "));
  const exitCode = classifyScanExit(result, "high");

  const lines: string[] = [
    "Codebase Doctor Demo",
    "====================",
    "",
    "Built a disposable fixture repository: a tracked secret, a broken import, and a dependency chain to trace impact. Nothing outside the temp directory was touched.",
    "",
    "Changed audit (the agent edit vs HEAD)",
    "--------------------------------------",
    renderBriefReport(result).trimEnd(),
    "",
  ];

  if (impacts.length > 0) {
    lines.push("Blast radius", "------------", ...impacts, "");
  }

  lines.push(
    `Exit code ${exitCode}: this is what CI sees at --fail-on high.`,
    "The fixture directory was removed. Every finding carries evidence; coverage limits are printed, never hidden.",
  );

  return `${lines.join("\n")}\n`;
}

function replayOutput(reason: string): string {
  return [
    `Note: ${reason}`,
    "Showing a recorded run instead. Install git to see it live.",
    "",
    DEMO_REPLAY_OUTPUT.trimEnd(),
    "",
  ].join("\n");
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function liveDemo(): Promise<DemoOutcome> {
  const root = await mkdtemp(join(tmpdir(), "codebase-doctor-demo-"));

  try {
    await writeFixture(root, DEMO_FIXTURE_FILES);
    await git(root, ["init", "-q"]);
    await git(root, ["add", "-A"]);
    await git(root, [
      "-c",
      "user.name=Codebase Doctor Demo",
      "-c",
      "user.email=demo@example.com",
      "commit",
      "-q",
      "-m",
      "clean fixture",
    ]);
    await writeFixture(root, DEMO_BROKEN_FILES);

    const result = await auditCodebase({
      root,
      runChecks: false,
      format: "text",
      timeoutMs: DEMO_TIMEOUT_MS,
      failOn: "high",
      includeDatabaseAudit: true,
      includeSecurityAudit: true,
      changed: true,
    });

    return {
      output: renderDemoOutput(result),
      live: true,
      exitCode: classifyScanExit(result, "high"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture(root: string, files: readonly DemoFile[]): Promise<void> {
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, maxBuffer: 1024 * 1024 });
}
