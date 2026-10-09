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
export { AUDIT_DOMAINS } from "./core/domain-coverage.js";
export type {
  AuditDomain,
  DomainApplicability,
  DomainCoverage,
  DomainCoverageEvidence,
  DomainCoverageStatus,
  DomainModuleCoverage,
} from "./core/domain-coverage.js";
export {
  BaselineError,
  compareFindingBaseline,
  loadBaseline,
  withBaselineComparison,
} from "./core/baseline.js";
export {
  applySuppressions,
  parseSuppressionDirectives,
} from "./core/suppressions.js";
export type {
  SuppressedFinding,
  SuppressionDirective,
  SuppressionOptions,
  SuppressionOutcome,
} from "./core/suppressions.js";
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
export {
  bandForScore,
  INCOMPLETE_COVERAGE_PENALTY,
  scoreReport,
  scoreScanResult,
  SEVERITY_PENALTIES,
} from "./core/score.js";
export type { ScoreBand, ScoreReport } from "./core/score.js";
export { renderScoreLine, scoreBadgeUrl } from "./reporters/score.js";
export type { ScoreRenderOptions } from "./reporters/score.js";
export {
  buildReceipt,
  canonicalJson,
  receiptDigest,
  RECEIPT_VERSION,
  serializeReceipt,
  verifyReceipt,
} from "./receipts/receipt.js";
export type {
  BuildReceiptOptions,
  CoverageReceipt,
  ReceiptVerification,
} from "./receipts/receipt.js";
export { runShadow } from "./shadow/runner.js";
export type { ShadowFormat, ShadowOptions, ShadowOutcome } from "./shadow/runner.js";
export { renderBisectText, runBisect } from "./bisect/runner.js";
export type {
  BisectEvidence,
  BisectOptions,
  BisectOutcome,
  BisectResult,
} from "./bisect/runner.js";
export { runSwarm } from "./swarm/runner.js";
export type { SwarmOptions, SwarmOutcome, SwarmRepoReport } from "./swarm/runner.js";
export { composeFleetVerdict, composeRepoVerdict } from "./swarm/verdict.js";
export type { RepoVerdict, RepoVerdictComposition } from "./swarm/verdict.js";
export {
  buildPheromone,
  mergePheromones,
  PHEROMONE_VERSION,
  renderIndexText,
  serializePheromone,
  verifyPheromone,
} from "./pheromones/pheromone.js";
export type {
  MergeOptions,
  MergeResult,
  PheromoneIndex,
  PheromoneIndexPattern,
  PheromonePattern,
  PheromoneSignal,
  PheromoneVerification,
} from "./pheromones/pheromone.js";
export { renderJsonReport } from "./reporters/json.js";
export { renderHtmlReport } from "./reporters/html.js";
export { renderSarifReport } from "./reporters/sarif.js";
export { renderTextReport } from "./reporters/text.js";
export type { TextReportOptions } from "./reporters/text.js";
export { renderBriefReport } from "./reporters/brief.js";
export type { BriefRenderOptions } from "./reporters/brief.js";
export { renderMarkdownReview } from "./reporters/markdown.js";
export type { MarkdownReviewOptions } from "./reporters/markdown.js";
export { renderGithubAnnotations } from "./reporters/github.js";
export type { GithubAnnotationsOptions } from "./reporters/github.js";
export {
  getChangedLines,
  parseUnifiedDiffZeroContext,
} from "./review/changed-lines.js";
export type {
  ChangedLines,
  ChangedLineSet,
  ChangedLinesOptions,
  ChangedLinesRunner,
} from "./review/changed-lines.js";
export { filterFindingsToDiff } from "./review/filter.js";
export type { DiffFilterOptions, DiffFilterResult } from "./review/filter.js";
export {
  classifyReviewExit,
  decideReviewVerdict,
  REVIEW_VERDICTS,
  selectVerdictFindings,
} from "./review/verdict.js";
export type { ReviewVerdict } from "./review/verdict.js";
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
  GitScopeErrorCode,
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
export type {
  MissingTargetProof,
  SourceGraph,
  SourceGraphEdge,
  SourceGraphNode,
  SourceGraphStatus,
  SourceImpact,
  SourceImpactRecord,
} from "./source-graph/types.js";
export type { DetectedProject } from "./workspace/types.js";
