import type { Confidence, Severity } from "../../../core/findings.js";

export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export type NpmLockOwnership =
  | "governed"
  | "explicit-standalone"
  | "unresolved";

export type SafeSourceClass =
  | "registry"
  | "local-file"
  | "local-link"
  | "workspace"
  | "secure-https"
  | "secure-ssh"
  | "insecure-http"
  | "insecure-git"
  | "git-pinned"
  | "git-mutable"
  | "unknown";

export interface SafeSourceClassification {
  readonly sourceClass: SafeSourceClass;
  readonly gitPinned: boolean;
}

export type DependencyFindingFamily =
  | "missing-lockfile"
  | "manifest-lock-drift"
  | "insecure-source"
  | "mutable-git-source"
  | "missing-integrity"
  | "workspace-registry-resolution"
  | "competing-npm-lockfiles";

export interface DependencyMatch {
  readonly family: DependencyFindingFamily;
  readonly path: string;
  readonly packageName?: string;
  readonly section?: DependencySection;
  readonly sourceClass?: SafeSourceClass;
  readonly severity: Severity;
  readonly confidence: Confidence;
}
