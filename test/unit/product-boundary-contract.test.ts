import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const canonicalDocuments = [
  "README.md",
  "docs/architecture.md",
  ".agents/skills/codebase-doctor/SKILL.md",
] as const;

const historicalPlans = [
  "docs/plans/2026-07-15-agent-verification-platform-design.md",
  "docs/plans/2026-07-15-codebase-doctor-design.md",
  "docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md",
  "docs/plans/2026-07-15-core-ci-foundation-design.md",
  "docs/plans/2026-07-15-core-ci-foundation.md",
  "docs/plans/2026-07-15-static-sql-rls-audit-design.md",
  "docs/plans/2026-07-15-static-sql-rls-audit.md",
  "docs/plans/2026-07-15-unified-rls-audit-design.md",
  "docs/plans/2026-07-15-unified-rls-audit.md",
] as const;

const supersededPlans = historicalPlans.slice(0, 2);
const targetWriteCapability = new RegExp(["filesystem", "write"].join(":"), "i");

const unifiedProductDocuments = [
  ...canonicalDocuments,
  "docs/plans/2026-07-15-core-ci-foundation-design.md",
  "docs/plans/2026-07-15-unified-rls-audit-design.md",
  "docs/plans/2026-07-15-static-sql-rls-audit-design.md",
  "docs/plans/2026-07-16-agent-native-changed-audit-design.md",
  "docs/plans/2026-07-16-independent-auditor-boundary-design.md",
] as const;

async function documents(paths: readonly string[]) {
  return Promise.all(paths.map(async (path) => ({
    path,
    text: await readFile(path, "utf8"),
  })));
}

describe("independent auditor product boundary", () => {
  it("pins non-executing source graph parsers exactly", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.["@babel/parser"]).toBe("8.0.4");
    expect(manifest.dependencies?.["jsonc-parser"]).toBe("3.3.1");
  });

  it("states the permanent builder and verifier separation", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/Models build\. Codebase Doctor verifies\./i);
      expect(text, path).toMatch(/human|external coding agent|separately authorized.*agent/is);
      expect(text, path).toMatch(/no direct target-file write API/is);
      expect(text, path).toMatch(/remediation.*guidance|guidance.*remediation/is);
    }
  });

  it("does not reserve repair or write authority in canonical documents", async () => {
    const forbidden = [
      /safe repair/i,
      /controlled repair workflow/i,
      /repair-loop coordination/i,
      /AI explanations and repair/i,
      targetWriteCapability,
      /Codebase Doctor (?:fixes|applies|rewrites|mutates) (?:the )?target/i,
      /Codebase Doctor can (?:ever )?(?:receive|request|obtain|be granted).*(?:target[- ]write|write authority|repair permission)/i,
      /grant Codebase Doctor.*(?:target[- ]write|write authority|repair permission)/i,
    ];

    for (const { path, text } of await documents(canonicalDocuments)) {
      for (const pattern of forbidden) expect(text, `${path}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("distinguishes direct repair authority from permitted repository checks", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/no direct target-file write API/is);
      expect(text, path).toMatch(/no direct\s+filesystem-write capability/is);
      expect(text, path).toMatch(/no remediation executor/is);
      expect(text, path).toMatch(
        /never.*granted direct target-write or remediation authority/is,
      );
      expect(text, path).toMatch(
        /--run-checks.*repository-owned validation\s+subprocesses.*not.*filesystem.*network.*isolated.*side\s+effects/is,
      );
      expect(text, path).toMatch(/validation execution.*not.*Doctor repair authority/is);
    }

    const [readme, changelog] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("CHANGELOG.md", "utf8"),
    ]);
    for (const text of [readme, changelog]) {
      expect(text).not.toMatch(/(?:has|contains|guarantee.*has) no target-write capability/i);
      expect(text).not.toMatch(/There is no target-write capability/i);
    }
  });

  it("keeps delivered audit and live RLS behavior out of the roadmap", async () => {
    const readme = await readFile("README.md", "utf8");
    const roadmap = readme.slice(readme.indexOf("## Roadmap"));

    expect(roadmap).not.toMatch(/Release the unified `audit` command/i);
    expect(roadmap).not.toMatch(/internal RLS module/i);
  });

  it("documents changed audits as mixed-scope per doctor", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/changed mode.*mixed[- ]scope|mixed[- ]scope.*changed mode/is);
      expect(text, path).toMatch(
        /Project Doctor.*full repository snapshot.*(?:manifests|lockfiles|workspaces|test visibility)/is,
      );
      expect(text, path).toMatch(
        /(?:configured validation|check).*plans?.*(?:filtered|restricted).*affectedProjectIds/is,
      );
      expect(text, path).toMatch(
        /static SQL.*affected migration streams?.*full current\s+history/is,
      );
      expect(text, path).toMatch(
        /live database.*full observed schema[- ]set\s+audit.*--with-database/is,
      );
      expect(text, path).not.toMatch(
        /does not audit unaffected repository areas|says nothing about unaffected repository areas/i,
      );
    }
  });

  it("maps the changed-audit pipeline without an affected-only Project Doctor", async () => {
    const architecture = await readFile("docs/architecture.md", "utf8");

    expect(architecture).not.toMatch(/full context for\s+selected projects/is);
    expect(architecture).not.toMatch(/projects that are actually audited/i);
    expect(architecture).not.toMatch(/selection is applied to\s+doctor work/is);
    expect(architecture).toMatch(
      /project doctor.*check planner.*SQL stream selector.*full (?:repository )?snapshot.*affected plans.*affected streams/is,
    );
    expect(architecture).toMatch(
      /live database doctor.*full observed schema set.*separate.*--with-database/is,
    );
  });

  it("keeps historical plans inside the same permanent boundary", async () => {
    const forbidden = [
      /repair-loop coordination/i,
      /verification-gated repair/i,
      /controlled (?:agent )?repair/i,
      /guide repair/i,
      /AI explanations and repair/i,
      targetWriteCapability,
    ];

    for (const { path, text } of await documents(historicalPlans)) {
      for (const pattern of forbidden) expect(text, `${path}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("does not label superseded product directions as approved", async () => {
    for (const { path, text } of await documents(supersededPlans)) {
      expect(text, path).toMatch(/^\*\*Status:\*\* Superseded[ \t]*$/m);
      expect(text, path).not.toMatch(/^\*\*Status:\*\* Approved/m);
    }
  });

  it("keeps current product direction inside one unified auditor", async () => {
    const separateProductDirection = [
      /future .*doctor packages/i,
      /specialized doctor packs/i,
      /specialized doctor packages and external tools/i,
      /@codebase-doctor\/(?:frontend|backend|database|security|infrastructure|performance|ai)/i,
      /specialized analysis should live in curated packages/i,
    ];

    for (const { path, text } of await documents(unifiedProductDocuments)) {
      for (const pattern of separateProductDirection) {
        expect(text, `${path}: ${pattern}`).not.toMatch(pattern);
      }
    }

    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/one (?:unified )?(?:full-codebase )?auditor|one doctor for the whole codebase/is);
      expect(text, path).toMatch(/built-in|internal audit modules/is);
    }
  });

  it("does not leave superseded external protocols as executable next steps", async () => {
    for (const { path, text } of await documents(supersededPlans)) {
      expect(text, path).not.toMatch(
        /## Immediate Next Step[\s\S]*implement external-doctor protocol/i,
      );
      expect(text, path).not.toMatch(
        /## Implementation Order[\s\S]*external doctor adapters/i,
      );
    }
  });

  it("distinguishes shipped audit coverage from the full-codebase north star", async () => {
    const [readme, architecture, skill] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/architecture.md", "utf8"),
      readFile(".agents/skills/codebase-doctor/SKILL.md", "utf8"),
    ]);

    expect(readme).toMatch(/## Current coverage versus north star/i);
    expect(readme).toMatch(/\|\s*Domain\s*\|\s*Current source coverage\s*\|\s*North star\s*\|/i);
    expect(readme).toMatch(/source-impact graph.*secrets analysis.*dependency analysis.*ship.*`?0\.1\.4`?/is);
    expect(readme).toMatch(/not part.*historical.*`?0\.1\.3`?/is);

    for (const [path, text] of [
      ["README.md", readme],
      ["docs/architecture.md", architecture],
      [".agents/skills/codebase-doctor/SKILL.md", skill],
    ] as const) {
      expect(text, path).toMatch(
        /full audit.*(?:requested|repository) scope.*not.*(?:complete|universal|every).*(?:domain|analyzer|coverage)/is,
      );
      expect(text, path).toMatch(/inspect.*coverage.*before.*(?:verified|clean)|coverage.*before.*(?:verified|clean)/is);
    }
  });

  it("documents the machine-readable domain coverage contract without overstating assurance", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/domainCoverage/);
      expect(text, path).toMatch(/applicability.*status|status.*applicability/is);
      expect(text, path).toMatch(/module[- ]level|modules.*status|status.*modules/is);
      expect(text, path).toMatch(/coverageComplete/);
      expect(text, path).toMatch(
        /coverageComplete.*does not mean.*(?:bug[- ]free|no bugs|correct)|(?:bug[- ]free|no bugs|correct).*coverageComplete/is,
      );
    }
  });

  it("documents the built-in secrets audit without treating local env storage as a leak", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/security\/secrets/);
      expect(text, path).toMatch(/ignored.*\.env.*(?:normal|not.*finding|not.*scan)/is);
      expect(text, path).toMatch(/tracked|repository-shareable/is);
      expect(text, path).toMatch(/credential|secret/is);
      expect(text, path).toMatch(/value.*withheld|withhold.*value/is);
      expect(text, path).toMatch(/never.*fingerprint|fingerprint.*never/is);
      expect(text, path).toMatch(/read-only/is);
      expect(text, path).toMatch(/offline/is);
      expect(text, path).toMatch(/precision-first/is);
      expect(text, path).toMatch(/not exhaustive|non-exhaustive/is);
      expect(text, path).toMatch(/external.*(?:rotate|revoke|remediat).*rerun|(?:rotate|revoke|remediat).*external.*rerun/is);
    }
  });

  it("documents the built-in dependency audit with exact offline claims", async () => {
    const requiredRules = [
      "missing-lockfile",
      "manifest-lock-drift",
      "insecure-source",
      "mutable-git-source",
      "missing-integrity",
      "workspace-registry-resolution",
      "competing-npm-lockfiles",
    ];
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/security\/dependencies/);
      expect(text, path).toMatch(/npm.*lockfile.*(?:versions? )?2.*3|npm.*v2.*v3/is);
      expect(text, path).toMatch(/pnpm.*Yarn.*Bun.*unsupported|unsupported.*pnpm.*Yarn.*Bun/is);
      expect(text, path).toMatch(/read-only/is);
      expect(text, path).toMatch(/offline/is);
      expect(text, path).toMatch(/never.*(?:invoke|run|execute).*(?:npm|package manager)|(?:npm|package manager).*(?:not|never).*(?:invoke|run|execute)/is);
      expect(text, path).toMatch(/no.*(?:CVE|advisory)|(?:CVE|advisory).*(?:not|no|without)/is);
      expect(text, path).toMatch(/semver.*range.*not.*finding|not.*flag.*(?:normal|ordinary).*range/is);
      expect(text, path).toMatch(/raw.*(?:specification|source|URL).*(?:withheld|never.*fingerprint)|(?:withheld|never.*fingerprint).*raw.*(?:specification|source|URL)/is);
      expect(text, path).toMatch(/external.*(?:human|agent).*(?:remediat|correct|change).*rerun.*same.*scope/is);
      expect(text, path).toMatch(/coverage.*before.*(?:clean|verified)|inspect.*coverage/is);
      for (const rule of requiredRules) expect(text, `${path}: ${rule}`).toContain(rule);
    }

    const changelog = await readFile("CHANGELOG.md", "utf8");
    const release = changelog.slice(
      changelog.indexOf("## [0.1.4]"),
      changelog.indexOf("## [0.1.3]"),
    );
    expect(release).toMatch(/security\/dependencies/);
    expect(release).toMatch(/offline.*read-only|read-only.*offline/is);
  });

  it("documents the bounded source-impact graph without overstating topology", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/repository\/source-graph/);
      expect(text, path).toMatch(/JavaScript.*TypeScript|TypeScript.*JavaScript/is);
      expect(text, path).toMatch(/import.*re-export.*require.*literal dynamic import/is);
      expect(text, path).toMatch(/syntax\s+parser.*never executes|never executes.*syntax\s+parser/is);
      expect(text, path).toMatch(/local.*(?:tsconfig|jsconfig).*deterministic\s+subset/is);
      expect(text, path).toMatch(/not.*complete.*(?:Node|TypeScript).*resolution/is);
      expect(text, path).toMatch(
        /dynamic.*ambiguous.*unsupported.*ceiling.*coverage\s+limitations?.*not.*findings?/is,
      );
      expect(text, path).toMatch(/cycles?.*not.*finding/is);
      expect(text, path).toMatch(/sourceImpact.*schema.*1/is);
      expect(text, path).toMatch(/shortest.*impact path/is);
      expect(text, path).toMatch(/full.*count.*bounded.*records|bounded.*records.*full.*count/is);
      expect(text, path).toMatch(/raw.*(?:import )?specifier.*source.*withheld/is);
      expect(text, path).toMatch(/read-only.*offline|offline.*read-only/is);
      expect(text, path).toMatch(/no plugins?.*network.*writes?|no network.*plugins?.*writes?/is);
    }

    const changelog = await readFile("CHANGELOG.md", "utf8");
    const release = changelog.slice(
      changelog.indexOf("## [0.1.4]"),
      changelog.indexOf("## [0.1.3]"),
    );
    expect(release).toMatch(/repository\/source-graph/);
    expect(release).toMatch(/sourceImpact/);
  });

  it("documents the separate precision-first source-integrity Doctor", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/repository\/source-integrity/);
      expect(text, path).toMatch(/source\/import-target-missing/);
      expect(text, path).toMatch(
        /repository\/source-graph.*finding-free.*repository\/source-integrity|repository\/source-integrity.*separate.*repository\/source-graph/is,
      );
      expect(text, path).toMatch(/precision-first/);
      expect(text, path).toMatch(
        /explicit.*relative.*supported.*extension.*single.*alias.*explicit.*supported.*(?:file|target).*unique.*workspace.*explicit.*(?:entry|file)/is,
      );
      expect(text, path).toMatch(
        /extensionless.*JSON.*custom.*conditional.*ambiguous.*external.*dynamic.*cycles?.*not.*findings?/is,
      );
      expect(text, path).toMatch(/does not (?:check|validate).*(?:named export|export name)/is);
      expect(text, path).toMatch(
        /full.*qualifying.*edges.*changed.*changed importers.*reverse[- ]impacted importers/is,
      );
      expect(text, path).toMatch(/deleted.*renamed.*target.*importer/is);
      expect(text, path).toMatch(/1,000.*findings.*partial coverage|partial coverage.*1,000.*findings/is);
      expect(text, path).toMatch(/raw.*import specifier.*source text.*withheld/is);
      expect(text, path).toMatch(/coverage.*partial.*not.*clean|partial.*coverage.*not.*clean/is);
      expect(text, path).toMatch(
        /external.*(?:human|agent).*(?:correct|restore|change).*rerun.*same.*scope/is,
      );
      expect(text, path).toMatch(/Codebase Doctor (?:never|does not).*(?:modify|repair|fix)/is);
    }

    const changelog = await readFile("CHANGELOG.md", "utf8");
    const release = changelog.slice(
      changelog.indexOf("## [0.1.5]"),
      changelog.indexOf("## [0.1.4]"),
    );
    expect(release).toMatch(/repository\/source-integrity/);
    expect(release).toMatch(/source\/import-target-missing/);
    expect(release).toMatch(/first ships.*0\.1\.5.*not part.*0\.1\.4/is);
  });
});
