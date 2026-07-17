export interface ProviderSecretPattern {
  readonly detectorId: string;
  readonly expression: RegExp;
}

export const PROVIDER_SECRET_PATTERNS: readonly ProviderSecretPattern[] = [
  { detectorId: "github-classic", expression: /\bghp_[A-Za-z0-9]{20,255}\b/gu },
  { detectorId: "github-fine-grained", expression: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/gu },
  { detectorId: "github-oauth", expression: /\bgho_[A-Za-z0-9]{20,255}\b/gu },
  { detectorId: "github-user", expression: /\bghu_[A-Za-z0-9]{20,255}\b/gu },
  { detectorId: "github-installation", expression: /\bghs_[A-Za-z0-9._=-]{20,512}(?![A-Za-z0-9._=-])/gu },
  { detectorId: "github-refresh", expression: /\bghr_[A-Za-z0-9]{20,255}\b/gu },
  { detectorId: "gitlab-personal", expression: /\bglpat-[A-Za-z0-9_-]{20,255}\b/gu },
  { detectorId: "gitlab-oauth-secret", expression: /\bgloas-[A-Za-z0-9_-]{20,255}\b/gu },
  { detectorId: "gitlab-deploy", expression: /\bgldt-[A-Za-z0-9_-]{20,255}\b/gu },
  { detectorId: "gitlab-runner", expression: /\bglrtr?-[A-Za-z0-9_-]{20,255}\b/gu },
  { detectorId: "slack-bot", expression: /\bxoxb-[A-Za-z0-9-]{20,255}\b/gu },
  { detectorId: "slack-user", expression: /\bxoxp-[A-Za-z0-9-]{20,255}\b/gu },
  { detectorId: "slack-app", expression: /\bxapp-[A-Za-z0-9-]{20,255}\b/gu },
  { detectorId: "slack-workflow", expression: /\bxwfp-[A-Za-z0-9-]{20,255}\b/gu },
] as const;
