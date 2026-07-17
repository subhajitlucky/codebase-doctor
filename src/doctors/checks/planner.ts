import type { CommandPlan } from "../../execution/types.js";
import type { ProjectSnapshot } from "../../workspace/types.js";
import { planJavaScriptChecks } from "./javascript.js";
import { planPythonChecks } from "./python.js";

export function planChecks(
  snapshot: ProjectSnapshot,
  timeoutMs: number,
): readonly CommandPlan[] {
  const plans = [
    ...planJavaScriptChecks(snapshot, timeoutMs),
    ...planPythonChecks(snapshot, timeoutMs),
  ];
  if (snapshot.auditScope.mode === "full") return Object.freeze(plans);

  const affectedProjectIds = new Set(snapshot.auditScope.affectedProjectIds);
  return Object.freeze(plans.filter(({ projectId }) => affectedProjectIds.has(projectId)));
}
