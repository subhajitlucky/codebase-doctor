import { describe, expect, it } from "vitest";
import { DEMO_REPLAY_OUTPUT } from "../../src/demo/fixture.js";
import { runDemo } from "../../src/demo/runner.js";

describe("codebase-doctor demo", () => {
  it(
    "runs the live fixture audit with a secret, a broken import, and blast radius",
    async () => {
      const outcome = await runDemo();

      expect(outcome.live).toBe(true);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.output).toContain("security/secrets/provider-token");
      expect(outcome.output).toContain("source/import-target-missing");
      expect(outcome.output).toContain("Blast radius");
      expect(outcome.output).toContain("src/config.ts → src/db.ts → src/jobs.ts");
      expect(outcome.output).toContain("Exit code 1");
    },
    30_000,
  );

  it("falls back to a recorded run when git is unavailable", async () => {
    const outcome = await runDemo({ isGitAvailable: async () => false });

    expect(outcome.live).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("Git was not found on this machine.");
    expect(outcome.output).toContain("Showing a recorded run instead.");
    expect(outcome.output).toContain("security/secrets/provider-token");
    expect(DEMO_REPLAY_OUTPUT).toContain("Blast radius");
  });

  it("falls back when the live demo fails", async () => {
    const outcome = await runDemo({
      isGitAvailable: async () => true,
      runLiveDemo: async () => {
        throw new Error("git exploded");
      },
    });

    expect(outcome.live).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("git exploded");
  });

  it("returns live output when the live demo succeeds", async () => {
    const outcome = await runDemo({
      isGitAvailable: async () => true,
      runLiveDemo: async () => ({ output: "LIVE\n", live: true, exitCode: 1 }),
    });

    expect(outcome).toEqual({ output: "LIVE\n", live: true, exitCode: 1 });
  });
});
