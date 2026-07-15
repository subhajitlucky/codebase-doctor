export const VERSION = "0.1.0";

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
export { summarizeFindings } from "./core/summary.js";
export type { FindingSummary } from "./core/summary.js";
