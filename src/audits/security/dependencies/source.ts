import type {
  SafeSourceClassification,
  SafeSourceClass,
} from "./types.js";

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/iu;
const SAFE_UNSCOPED_NAME = /^[A-Za-z0-9._~-]+$/u;
const SAFE_SCOPED_NAME = /^@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+$/u;
const MAX_NPM_NAME_LENGTH = 214;

function fragmentOf(value: string): string | undefined {
  const marker = value.lastIndexOf("#");
  if (marker < 0 || marker === value.length - 1) return undefined;
  return value.slice(marker + 1);
}

function isGitSource(value: string): boolean {
  return /^(?:git\+|git@|git:|ssh:|github:|gitlab:|bitbucket:)/iu.test(value) ||
    /^[^\s/:]+\/[^\s/]+(?:#.*)?$/u.test(value) ||
    /^https:\/\/[^\s]+\.git(?:#.*)?$/iu.test(value);
}

function classification(sourceClass: SafeSourceClass, gitPinned = false): SafeSourceClassification {
  return { sourceClass, gitPinned };
}

export function classifyDependencySource(rawValue: string): SafeSourceClassification {
  const value = rawValue.trim();
  const lower = value.toLowerCase();

  if (lower.startsWith("git+http://") || lower.startsWith("http://")) {
    return classification("insecure-http");
  }
  if (lower.startsWith("git://")) return classification("insecure-git");
  if (lower.startsWith("file:")) return classification("local-file");
  if (lower.startsWith("link:")) return classification("local-link");
  if (lower.startsWith("workspace:")) return classification("workspace");

  if (isGitSource(value)) {
    const pinned = FULL_GIT_COMMIT.test(fragmentOf(value) ?? "");
    return classification(pinned ? "git-pinned" : "git-mutable", pinned);
  }

  if (lower.startsWith("https://")) return classification("secure-https");
  if (lower.startsWith("ssh://")) return classification("secure-ssh");
  if (/^(?:[~^]|[<>=*]|\d|latest\b|next\b)/iu.test(value)) {
    return classification("registry");
  }
  return classification("unknown");
}

export function safeNpmPackageName(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_NPM_NAME_LENGTH) return undefined;
  if (SAFE_UNSCOPED_NAME.test(value) || SAFE_SCOPED_NAME.test(value)) return value;
  return undefined;
}
