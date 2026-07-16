# Agent-Native Changed Audit Design

**Date:** 2026-07-16
**Status:** Approved

## Objective

Make Codebase Doctor fast and precise enough for coding agents to run after
every meaningful change while preserving its permanent independence:

> **Models build. Codebase Doctor verifies.**

This milestone adds affected-scope auditing and a model-oriented finding
contract. It does not add target-file writes, automatic remediation, or an
agent that changes code.

## Product experience

The primary local-agent workflow is:

```bash
codebase-doctor audit . --changed --json
```

By default, `--changed` audits staged, unstaged, and untracked changes relative
to `HEAD`. A branch or pull-request workflow can select a base:

```bash
codebase-doctor audit . --changed --base main --json
```

When `--base` is supplied, Codebase Doctor resolves the merge base of that ref
and `HEAD`, then includes committed branch changes plus staged, unstaged, and
untracked worktree changes. `--base` is valid only with `--changed`.

Without `--changed`, the existing full-audit behavior and output remain
unchanged.

## Design choice

Three approaches were considered:

1. Run a full audit and hide unrelated findings. This is compatible but does
   not improve latency.
2. Inspect only directly changed files. This is fast but can miss effects on
   dependant projects and state reconstructed from multiple files.
3. Build an affected scope from changes, dependant projects, and doctor-specific
   context requirements.

The third approach is selected. It gives agents useful speed without turning a
partial inspection into a false clean result.

## Changed-file discovery

A read-only Git adapter discovers changes without modifying the index,
worktree, refs, or configuration. It records:

- added, modified, deleted, renamed, and copied tracked paths;
- staged and unstaged changes;
- untracked files not excluded by normal Git ignore rules;
- the requested base and resolved base commit;
- the old path for renames and copies.

Paths are normalized to repository-relative POSIX form and sorted
deterministically. Duplicate paths across Git views are reduced into one
logical change record without losing the strongest status evidence.

If changed mode is requested outside a Git worktree, the base cannot be
resolved, Git output is malformed, or the repository root differs from the Git
worktree in a way that cannot be represented safely, the CLI exits `2`. It does
not fall back silently to a clean or incomplete result.

Git discovery is observational. It requires no target-write capability and
executes only fixed Git argument arrays, never shell-interpolated commands.

## Audit scope

The repository inventory remains available as full read-only context. Changed
mode adds an audit scope containing:

```ts
interface AuditScope {
  mode: "full" | "changed";
  base: null | {
    kind: "head" | "merge-base";
    requestedRef: string | null;
    resolvedCommit: string;
  };
  changes: readonly ChangedPath[];
  affectedProjectIds: readonly string[];
  reasons: readonly ScopeReason[];
  limitations: readonly string[];
}
```

Directly changed paths affect the deepest detected project that contains them.
Root configuration files may affect every project. For JavaScript and
TypeScript workspaces, reverse workspace dependency closure adds dependant
projects when their manifests expose enough static package-name and dependency
information. Unknown dependency relationships become explicit limitations.

An empty changed set is a successful changed audit with empty affected scope;
coverage and scope still make clear that this was not a full repository audit.

## Doctor selection

Changed mode does not impose one unsafe filtering rule on every doctor. Each
doctor is assigned one of three execution strategies:

- **Affected:** examine affected projects or changed paths only.
- **Full context:** run because the rule depends on repository-wide state.
- **Not selected:** skip with an explicit scope reason when the doctor has no
  applicable affected input.

For the existing doctors:

- Project structure rules use full repository context because lockfiles,
  workspace declarations, manifests, and test visibility can cross project
  boundaries.
- Configured checks are planned only for affected projects and statically known
  dependant workspaces.
- Static SQL RLS analysis selects any migration stream containing a changed,
  deleted, or formerly named migration path, then rereads the complete selected
  stream so historical state is reconstructed correctly.
- Live PostgreSQL RLS auditing remains independently permissioned. Changed mode
  never grants network access. If `--with-database` is explicitly present, the
  live catalog remains a full observed-state audit rather than pretending the
  database has a file-level diff.

Every doctor run records why it ran or why it was not selected. Coverage states
what was examined, what was outside the selected scope, and any analysis
limitations. A changed audit never represents unaffected code as audited.

## Report contract

Schema `1` receives additive fields so version `0.1.x` consumers remain
compatible:

```json
{
  "auditScope": {
    "mode": "changed",
    "base": {
      "kind": "head",
      "requestedRef": null,
      "resolvedCommit": "..."
    },
    "changes": [],
    "affectedProjectIds": [],
    "reasons": [],
    "limitations": []
  }
}
```

Full audits also emit `auditScope.mode = "full"`, making the difference
machine-readable without requiring agents to infer it from coverage text.

Coverage receives an additive selection reason where useful. Existing status
values retain their meaning.

## Model-oriented findings

The existing stable `fingerprint`, evidence, message, severity, confidence, and
string remediation remain compatible. Findings may add:

```ts
interface Finding {
  impact?: string;
  remediationConstraints?: readonly string[];
  verification?: {
    command: string;
    expected: string;
  };
}
```

These fields answer distinct agent questions:

- `impact`: what can happen if the defect remains;
- `remediationConstraints`: properties an external repair must preserve;
- `verification`: how to ask Codebase Doctor to independently evaluate the
  resulting state.

Verification commands are reported as instructions. Codebase Doctor never
executes them as remediation and never applies a patch. Existing findings are
upgraded incrementally; absence of optional guidance does not invalidate a
finding.

The fingerprint remains the canonical machine identity. Human-facing short IDs
or query commands can be added later without weakening baseline stability.

## Output and exit behavior

Text, JSON, and SARIF reporters continue to contain the same findings. JSON
adds structured scope and guidance. Text summarizes the selected change scope
before findings. SARIF includes optional impact and verification metadata while
retaining existing fingerprints and baseline states.

`--baseline` remains orthogonal to `--changed`:

- changed scope controls what Codebase Doctor examines;
- baseline comparison classifies findings produced by that examination.

Finding thresholds retain exit `0` and `1` behavior. Failure to determine a
requested changed scope exits `2`.

## Safety boundary

This milestone introduces no target-write authority. In particular:

- Git commands are read-only and fixed by the application;
- no baseline, cache, index, configuration, or report is written by the audit;
- `--changed` does not imply `--run-checks` or `--with-database`;
- project commands still require `--run-checks`;
- database access still requires `--with-database`;
- remediation and verification fields are guidance only.

Future sandboxing of configured checks is complementary work and is not
silently claimed by this milestone.

## Testing strategy

Unit tests cover Git porcelain parsing, deterministic change reduction, scope
construction, workspace dependant closure, finding guidance normalization, and
option validation.

Integration tests create disposable Git repositories and prove:

- staged, unstaged, untracked, deleted, and renamed paths are discovered;
- the default base is `HEAD`;
- explicit refs use their merge base with `HEAD`;
- invalid refs and non-Git roots exit `2`;
- affected checks are selected while unrelated checks are not;
- a changed SQL migration causes its complete stream to be analyzed;
- full audits remain compatible;
- JSON, text, SARIF, baselines, and exit thresholds remain deterministic;
- repository status and file contents are identical before and after a
  read-only audit, except for external commands explicitly authorized through
  `--run-checks`, whose isolation remains a separately disclosed limitation.

## Deferred work

This design establishes the contract needed by later agent integrations, but it
does not include:

- an MCP server or finding-query protocol;
- execution sandboxing;
- persistent caches;
- language-level import graphs beyond statically known workspace dependencies;
- automatic fixes or target-file writes;
- broad new React, authentication, infrastructure, or performance rules.

The next milestone after changed auditing should expose compact, read-only MCP
tools over the same audit scope, finding, fingerprint, and coverage contracts.
