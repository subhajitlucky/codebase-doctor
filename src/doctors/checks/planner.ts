import type { CommandPlan } from "../../execution/types.js";
import type { ProjectSnapshot } from "../../workspace/types.js";
import { planJavaScriptChecks } from "./javascript.js";
import { planPythonChecks } from "./python.js";

export function planChecks(
  snapshot: ProjectSnapshot,
  timeoutMs: number,
): readonly CommandPlan[] {
  let selectedSnapshot = snapshot;
  if (snapshot.auditScope.mode === "changed") {
    const affectedProjectIds = new Set(snapshot.auditScope.affectedProjectIds);
    selectedSnapshot = {
      ...snapshot,
      projects: snapshot.projects.filter(({ id }) => affectedProjectIds.has(id)),
    };
  }
  return Object.freeze([
    ...planJavaScriptChecks(selectedSnapshot, timeoutMs),
    ...planPythonChecks(selectedSnapshot, timeoutMs),
  ]);
}
