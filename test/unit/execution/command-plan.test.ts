import { describe, expect, it } from "vitest";
import { createCommandPlan, displayCommand } from "../../../src/execution/command-plan.js";

describe("command plans", () => {
  it("creates a frozen plan with a frozen argument array", () => {
    const plan = createCommandPlan({
      id: "root:js:test",
      projectId: "root",
      label: "JavaScript test",
      executable: "npm",
      args: ["run", "test"],
      cwd: "/tmp/project",
      timeoutMs: 60_000,
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.args)).toBe(true);
    expect(plan.args).toEqual(["run", "test"]);
  });

  it("renders a readable command without changing its argument array", () => {
    const plan = createCommandPlan({
      id: "display",
      projectId: "root",
      label: "Display",
      executable: "tool",
      args: ["plain", "hello world", "$HOME", "say\"hello"],
      cwd: "/tmp/project",
      timeoutMs: 1_000,
    });

    expect(displayCommand(plan)).toBe('tool plain "hello world" "$HOME" "say\\\"hello"');
    expect(plan.args).toEqual(["plain", "hello world", "$HOME", "say\"hello"]);
  });
});
