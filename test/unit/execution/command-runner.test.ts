import { describe, expect, it } from "vitest";
import { createCommandPlan } from "../../../src/execution/command-plan.js";
import { MAX_OUTPUT_BYTES_PER_STREAM, runCommand } from "../../../src/execution/command-runner.js";

function nodePlan(script: string, args: readonly string[] = [], timeoutMs = 2_000) {
  return createCommandPlan({
    id: "runner-test",
    projectId: "root",
    label: "Runner test",
    executable: process.execPath,
    args: ["-e", script, ...args],
    cwd: process.cwd(),
    timeoutMs,
  });
}

describe("bounded command runner", () => {
  it("captures stdout and stderr from a successful command", async () => {
    const result = await runCommand(nodePlan(
      "console.log('healthy'); console.error('warning')",
    ));

    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "healthy\n",
      stderr: "warning\n",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it("returns a completed result for a non-zero validation exit", async () => {
    const result = await runCommand(nodePlan("process.exit(3)"));

    expect(result).toMatchObject({ status: "completed", exitCode: 3 });
  });

  it("terminates and classifies a timed-out command", async () => {
    const result = await runCommand(nodePlan("setInterval(() => {}, 1000)", [], 50));

    expect(result.status).toBe("timed-out");
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it("truncates stdout and stderr independently at documented limits", async () => {
    const result = await runCommand(nodePlan(
      "process.stdout.write('o'.repeat(70000)); process.stderr.write('e'.repeat(70000))",
    ));

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES_PER_STREAM);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES_PER_STREAM);
    expect(result).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
  });

  it("returns failed-to-start when the executable does not exist", async () => {
    const result = await runCommand(createCommandPlan({
      id: "missing",
      projectId: "root",
      label: "Missing executable",
      executable: "codebase-doctor-definitely-missing-executable",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
    }));

    expect(result).toMatchObject({
      status: "failed-to-start",
      error: expect.stringMatching(/ENOENT|not found/i),
    });
  });

  it("passes shell metacharacters as one literal argument", async () => {
    const literal = "$(echo hacked); * && $HOME";
    const result = await runCommand(nodePlan("console.log(process.argv[1])", [literal]));

    expect(result).toMatchObject({ status: "completed", exitCode: 0, stdout: `${literal}\n` });
  });

  it("uses a minimal environment and excludes fixture secrets", async () => {
    const result = await runCommand(nodePlan(
      "console.log(JSON.stringify({path: process.env.PATH, ci: process.env.CI, color: process.env.NO_COLOR, secret: process.env.FIXTURE_TOKEN, random: process.env.RANDOM_VALUE}))",
    ), {
      sourceEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FIXTURE_TOKEN: "do-not-leak",
        RANDOM_VALUE: "also-excluded",
      },
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(JSON.parse(result.stdout)).toEqual({
      path: process.env.PATH,
      ci: "1",
      color: "1",
    });
  });
});
