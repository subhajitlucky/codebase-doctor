import type { CommandPlan } from "./types.js";

export function createCommandPlan(plan: CommandPlan): CommandPlan {
  return Object.freeze({
    ...plan,
    args: Object.freeze([...plan.args]),
  });
}

function quoteForDisplay(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

/** Returns evidence text only. Never pass this display string to a shell. */
export function displayCommand(plan: Pick<CommandPlan, "executable" | "args">): string {
  return [plan.executable, ...plan.args].map(quoteForDisplay).join(" ");
}
