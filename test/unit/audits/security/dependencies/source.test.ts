import { describe, expect, it } from "vitest";
import {
  classifyDependencySource,
  safeNpmPackageName,
} from "../../../../../src/audits/security/dependencies/source.js";

const FULL_COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("safe dependency source classification", () => {
  it.each([
    ["http://packages.example.invalid/archive.tgz", "insecure-http", false],
    ["git+http://git.example.invalid/team/repo.git", "insecure-http", false],
    ["git://git.example.invalid/team/repo.git", "insecure-git", false],
    ["https://packages.example.invalid/archive.tgz", "secure-https", false],
    ["git+ssh://git@example.invalid/team/repo.git", "git-mutable", false],
    [`git+https://example.invalid/team/repo.git#${FULL_COMMIT}`, "git-pinned", true],
    [`git+ssh://git@example.invalid/team/repo.git#${FULL_COMMIT}`, "git-pinned", true],
    ["github:owner/repository#main", "git-mutable", false],
    ["owner/repository", "git-mutable", false],
    ["git+https://example.invalid/team/repo.git#a1b2c3d4", "git-mutable", false],
    ["file:../shared", "local-file", false],
    ["link:../shared", "local-link", false],
    ["workspace:^", "workspace", false],
    ["^5.0.0", "registry", false],
  ] as const)("classifies %s safely", (source, sourceClass, gitPinned) => {
    expect(classifyDependencySource(source)).toEqual({ sourceClass, gitPinned });
  });

  it("never returns a credential-bearing source value", () => {
    const seed = ["sensitive", "-source-", "credential-93Xq"].join("");
    const source = `https://user:${seed}@packages.example.invalid/archive.tgz?token=${seed}`;
    const result = classifyDependencySource(source);

    expect(result).toEqual({ sourceClass: "secure-https", gitPinned: false });
    expect(JSON.stringify(result)).not.toContain(seed);
  });

  it.each([
    ["package-name", "package-name"],
    ["@scope/package-name", "@scope/package-name"],
    ["legacy.Package_1", "legacy.Package_1"],
    ["../escape", undefined],
    ["@scope/../../escape", undefined],
    ["name with spaces", undefined],
    ["https://example.invalid/package", undefined],
    ["", undefined],
  ] as const)("returns only safe npm package identifiers for %s", (value, expected) => {
    expect(safeNpmPackageName(value)).toBe(expected);
  });
});
