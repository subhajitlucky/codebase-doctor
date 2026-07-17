import type { Confidence, Severity } from "../../../core/findings.js";

export type SecretFindingFamily =
  | "private-key"
  | "provider-token"
  | "aws-credentials"
  | "credential-url"
  | "sensitive-assignment";

export interface SecretMatch {
  readonly detectorId: string;
  readonly family: SecretFindingFamily;
  readonly line: number;
  readonly column: number;
  readonly assignmentName?: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
}
