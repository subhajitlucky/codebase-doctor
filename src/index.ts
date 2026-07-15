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
export { scanCodebase } from "./core/scan.js";
export type { ScanDependencies, ScanHooks, ScanRequest } from "./core/scan.js";
export { hasFindingAtOrAbove, summarizeFindings } from "./core/summary.js";
export type {
  FindingSummary,
  FindingThreshold,
} from "./core/summary.js";
export { renderJsonReport } from "./reporters/json.js";
export { renderTextReport } from "./reporters/text.js";
export type { TextReportOptions } from "./reporters/text.js";
