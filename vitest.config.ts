import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    // Integration tests spawn the CLI through tsx (cold start) and one scans
    // the whole repository; the 5s default flakes on slower CI runners.
    // Must stay above the 15s spawnSync timeout used by CLI test helpers.
    testTimeout: 30_000,
  },
});
