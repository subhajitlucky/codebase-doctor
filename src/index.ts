import { discoverGitChanges as discoverGitChangesInternal } from "./scope/git.js";
import type {
  DiscoveredChanges,
  DiscoverChangesOptions,
} from "./scope/git.js";

export { VERSION } from "./version.js";

export {
  SEVERITIES,
  compareFindings,
  createFingerprint,
  sortFindings,
} from "./core/findings.js";
export type {
  Confidence,
  Evidence,
  Finding,
  FingerprintInput,
  Severity,
} from "./core/findings.js";
export { classifyScanExit } from "./core/normalize.js";
export type { DoctorRunRecord, ScanResult } from "./core/normalize.js";
export type { AuditCoverage, CoverageStatus } from "./core/doctor.js";
export {
  BaselineError,
  compareFindingBaseline,
  loadBaseline,
  withBaselineComparison,
} from "./core/baseline.js";
export type {
  BaselineReport,
  BaselineComparisonOptions,
  FindingComparison,
} from "./core/baseline.js";
export { auditCodebase, scanCodebase } from "./core/scan.js";
export type {
  AuditRequest,
  ScanDependencies,
  ScanHooks,
  ScanRequest,
} from "./core/scan.js";
export { hasFindingAtOrAbove, summarizeFindings } from "./core/summary.js";
export type {
  FindingSummary,
  FindingThreshold,
} from "./core/summary.js";
export { renderJsonReport } from "./reporters/json.js";
export { renderSarifReport } from "./reporters/sarif.js";
export { renderTextReport } from "./reporters/text.js";
export type { TextReportOptions } from "./reporters/text.js";
export {
  CodebaseConfigError,
  loadCodebaseConfig,
  validateExcludePattern,
} from "./config/config.js";
export type { CodebaseConfig } from "./config/config.js";
export type { PlannedCheckRecord } from "./execution/types.js";
export { GitScopeError } from "./scope/git.js";
export type {
  DiscoveredChanges,
  DiscoverChangesOptions,
} from "./scope/git.js";
export function discoverGitChanges(
  options: DiscoverChangesOptions,
): Promise<DiscoveredChanges> {
  return discoverGitChangesInternal(options);
}
export { fullAuditScope, planChangedScope } from "./scope/planner.js";
export type {
  AuditBase,
  AuditScope,
  ChangedPath,
  ChangeStatus,
  ScopeReason,
} from "./scope/types.js";
