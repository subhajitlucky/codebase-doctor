export const SOURCE_INTEGRITY_DOCTOR_ID = "repository/source-integrity";
export const MISSING_IMPORT_TARGET_RULE_ID = "source/import-target-missing";
export const DEFAULT_MAX_SOURCE_INTEGRITY_FINDINGS = 1_000;

export interface SourceIntegrityDoctorOptions {
  readonly maxFindings?: number;
}
