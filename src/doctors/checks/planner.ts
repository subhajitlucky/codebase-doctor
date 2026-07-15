import type { CommandPlan } from "../../execution/types.js";
import type { ProjectSnapshot } from "../../workspace/types.js";
import { planJavaScriptChecks } from "./javascript.js";
import { planPythonChecks } from "./python.js";

export function planChecks(
  snapshot: ProjectSnapshot,
  timeoutMs: number,
): readonly CommandPlan[] {
  return Object.freeze([
    ...planJavaScriptChecks(snapshot, timeoutMs),
    ...planPythonChecks(snapshot, timeoutMs),
  ]);
}
