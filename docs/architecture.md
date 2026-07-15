# Codebase Doctor Architecture

## Purpose

Codebase Doctor is a local-first diagnostic orchestrator for software repositories. It combines cross-project inspection with ecosystem-specific validation and returns normalized, evidence-backed findings.

The architecture must satisfy two goals that pull in opposite directions:

1. `0.1.0` must stay small enough to implement, test, and publish quickly.
2. The core contracts must support additional languages, external doctors, agent integrations, CI, and safe repair without a rewrite.

## Architectural Principles

1. **Deterministic core:** the same repository state and tool versions should produce the same findings.
2. **Evidence-backed findings:** a finding records the observation, location, and reproduction path when available.
3. **Read-only default:** repository discovery and static diagnostics cannot mutate the target.
4. **Capability-based execution:** doctors declare whether they need filesystem reads, subprocesses, network access, or writes.
5. **Explicit execution consent:** `0.1.0` enables subprocesses only with `--run-checks`.
6. **Stable contracts, replaceable adapters:** language and framework support lives behind doctor interfaces.
7. **Reporter separation:** terminal formatting never becomes the machine-readable API.
8. **Graceful partial failure:** one unsupported or failing doctor must not erase other useful results.
9. **Honest scope:** detection is not diagnosis, and absence of visible tests is not proof of absent testing.
10. **Model independence:** no OpenAI, Anthropic, or other model is required for core scans.

## System Shape

```text
User, coding agent, or CI
           |
           v
       CLI parser
           |
           v
   Scan request validator
           |
           v
     Workspace scanner
           |
           +--> file inventory
           +--> manifest inventory
           +--> language/framework signals
           +--> workspace/package graph
           |
           v
      Doctor registry
           |
           +--> Project Doctor (read-only)
           +--> Check Doctor (subprocess permission required)
           +--> future internal and external doctors
           |
           v
     Finding normalizer
           |
           +--> deduplication
           +--> severity summary
           +--> redaction
           +--> deterministic ordering
           |
           v
        Reporters
           +--> terminal text
           +--> JSON
           +--> future SARIF / Markdown / MCP
           |
           v
        Exit code
```

## Proposed Repository Layout

```text
codebase-doctor/
├── src/
│   ├── cli.ts
│   ├── index.ts
│   ├── commands/
│   │   └── scan.ts
│   ├── core/
│   │   ├── capabilities.ts
│   │   ├── doctor.ts
│   │   ├── findings.ts
│   │   ├── registry.ts
│   │   ├── scan.ts
│   │   └── summary.ts
│   ├── workspace/
│   │   ├── file-inventory.ts
│   │   ├── manifest-loader.ts
│   │   ├── project-detector.ts
│   │   └── types.ts
│   ├── execution/
│   │   ├── command-plan.ts
│   │   ├── command-runner.ts
│   │   ├── redaction.ts
│   │   └── types.ts
│   ├── doctors/
│   │   ├── project/
│   │   │   ├── doctor.ts
│   │   │   └── rules/
│   │   └── checks/
│   │       ├── doctor.ts
│   │       ├── javascript.ts
│   │       └── python.ts
│   └── reporters/
│       ├── json.ts
│       └── text.ts
├── test/
│   ├── fixtures/
│   ├── integration/
│   └── unit/
├── docs/
│   ├── architecture.md
│   └── plans/
├── package.json
├── tsconfig.json
└── README.md
```

This is a planned shape. Files should be introduced only when the implementation needs them.

## Core Domain Model

### Scan Request

```ts
export interface ScanRequest {
  root: string;
  runChecks: boolean;
  format: "text" | "json";
  timeoutMs: number;
  failOn: Severity | "none";
}
```

The CLI converts user input into a validated `ScanRequest`. Core scanning code must not depend on Commander types.

### Project Snapshot

```ts
export interface ProjectSnapshot {
  root: string;
  files: readonly FileRecord[];
  manifests: readonly ManifestRecord[];
  projects: readonly DetectedProject[];
  workspaces: readonly WorkspaceRecord[];
}
```

A snapshot is observation, not a diagnosis. Doctors consume it without rescanning the filesystem independently unless their declared capability requires deeper reads.

### Finding

```ts
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";

export interface Finding {
  ruleId: string;
  doctorId: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  title: string;
  message: string;
  location?: {
    path: string;
    line?: number;
    column?: number;
  };
  evidence: readonly Evidence[];
  remediation?: string;
  fingerprint: string;
}
```

`fingerprint` must be stable for the same logical issue so future baselines and diff scans can compare findings.

### Evidence

```ts
export type Evidence =
  | { type: "file"; path: string; detail: string }
  | { type: "manifest"; path: string; detail: string }
  | { type: "command"; command: string; exitCode: number; output?: string }
  | { type: "observation"; detail: string };
```

Reporters may abbreviate evidence for humans. JSON output preserves the structured form after redaction.

## Doctor Contract

```ts
export interface Doctor {
  id: string;
  version: string;
  capabilities: readonly Capability[];
  supports(snapshot: ProjectSnapshot): boolean | Promise<boolean>;
  diagnose(context: DoctorContext): Promise<DoctorResult>;
}

export type Capability =
  | "filesystem:read"
  | "process:execute"
  | "network:access"
  | "filesystem:write";

export interface DoctorResult {
  status: "completed" | "skipped" | "failed";
  findings: readonly Finding[];
  error?: OperationalError;
  durationMs: number;
}
```

Rules for `0.1.0`:

- Built-in doctors may request `filesystem:read`.
- Check Doctor may request `process:execute` only when `runChecks` is true.
- No built-in doctor receives `network:access` or `filesystem:write`.
- An operational doctor failure becomes scan metadata, not a fabricated code finding.
- Doctor results are normalized and sorted after all eligible doctors finish.

## Workspace Discovery

Workspace discovery performs bounded traversal and ignores common generated or vendor directories such as `.git`, `node_modules`, `.next`, `dist`, `build`, `.venv`, `venv`, `target`, and cache folders.

Detection uses evidence from known files rather than guessing from extensions alone:

| Ecosystem | Primary signals |
| --- | --- |
| JavaScript/TypeScript | `package.json`, lockfiles, workspace files, `tsconfig*.json` |
| Python | `pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`, lockfiles |
| Go | `go.mod`, `go.work` |
| Rust | `Cargo.toml`, `Cargo.lock` |
| Java/Kotlin | `pom.xml`, Gradle settings/build files |

`0.1.0` may detect more ecosystems than it can execute checks for. The report must distinguish `detected` from `check support available`.

## Project Doctor

Project Doctor owns cross-project, read-only rules. Initial rules should be narrow, reproducible, and low-noise:

- Conflicting package-manager lockfiles within one project boundary.
- Manifest files that cannot be parsed by the supported parser.
- Workspace entries that resolve to missing paths.
- Declared validation scripts that reference an obviously missing local file.
- Source inventory with no visible test files, reported as an informational signal.

Project Doctor must not label preferences as bugs. Missing README, license, CI, or a particular folder structure may be useful metadata but should not fail a scan.

## Check Doctor

Check Doctor turns existing repository configuration into an execution plan.

### Planning

1. Determine the project boundary and ecosystem.
2. Select the existing package manager or environment tool from lockfile/config evidence.
3. Discover only checks already declared or clearly configured.
4. Return the plan without executing it when `runChecks` is false.
5. Execute sequentially in `0.1.0` for predictable logs and resource use.

### JavaScript/TypeScript

Prefer declared scripts in this order when present:

1. `typecheck` or `check`
2. `test`
3. `lint`
4. `build`

Use the detected package manager. Never run lifecycle installation commands.

### Python

Only run a check when configuration and a locally available executable support it. Initial candidates are:

- pytest
- Ruff
- mypy

Codebase Doctor must not create a virtual environment or install a missing tool.

### Command Result Handling

- Exit code `0`: successful check, no failure finding.
- Non-zero expected validation exit: one finding containing the command and redacted output excerpt.
- Timeout: operational failure plus a high-confidence timeout finding when the target command started.
- Missing executable: skipped check with explanation, not a code defect.
- Signal or runner crash: operational failure recorded separately.

## Execution Safety

The subprocess runner is a trust boundary.

### `0.1.0` controls

- Execution disabled unless `--run-checks` is present.
- Display the command plan before execution in text mode.
- Spawn commands without a shell when possible.
- Use argument arrays instead of interpolated command strings.
- Set per-command timeouts.
- Limit captured stdout and stderr.
- Pass a minimal inherited environment and redact likely credentials.
- Never run dependency installation.
- Never allow doctor-provided filesystem writes.
- Record the exact command and exit code.

### Future controls

- Container or sandbox execution for untrusted repositories.
- CPU, memory, process, and filesystem quotas.
- Explicit network-deny enforcement rather than policy alone.
- Signed and permission-reviewed external doctor packages.

Until those controls exist, documentation must tell users not to execute checks from an untrusted repository.

## Finding Normalization

The normalizer performs:

1. Schema validation.
2. Secret redaction.
3. Stable fingerprint generation.
4. Exact-duplicate removal.
5. Deterministic sorting by severity, doctor, location, and rule.
6. Severity totals and highest-severity calculation.

Cross-doctor semantic deduplication is postponed until real duplicate patterns exist.

## Reporters

### Text

Optimized for local humans:

- concise repository summary
- detected project types
- execution plan and status
- findings ordered by severity
- direct next steps

### JSON

Optimized for agents and CI:

```json
{
  "schemaVersion": "1",
  "tool": { "name": "codebase-doctor", "version": "0.1.0" },
  "repository": { "root": "." },
  "projects": [],
  "doctorRuns": [],
  "findings": [],
  "summary": {
    "highestSeverity": "info",
    "counts": { "info": 0, "low": 0, "medium": 0, "high": 0, "critical": 0 }
  }
}
```

The JSON schema version is independent from the npm package version. Backward-incompatible report changes require a schema-version change.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Scan completed and no finding met the configured failure threshold |
| `1` | Scan completed and at least one finding met the threshold |
| `2` | The CLI could not perform the requested scan |

A failed project test normally produces a finding and exit `1`. Invalid CLI arguments or an unreadable scan root produce exit `2`.

## Agent Integration Strategy

The CLI and JSON contract come first. Agent surfaces remain adapters:

1. A `SKILL.md` teaches compatible agents when and how to run scans.
2. Lifecycle hooks run diff-aware scans after code changes or before an agent stops.
3. An MCP server exposes `inspect_repository`, `plan_checks`, and `run_checks` tools with explicit capability annotations.
4. A controlled repair workflow asks an agent to patch a finding in isolation, then accepts the patch only after deterministic verification.

No agent integration may bypass the CLI safety model.

## External Doctor Strategy

External doctors such as RLS Doctor remain separate packages and repositories.

The future adapter layer should support:

- executable adapters that consume and return JSON
- JavaScript package adapters using a published SDK
- MCP-backed remote doctors where local execution is unsuitable

Licenses and redistribution terms must be checked before bundling any third-party doctor. Optional user-installed tools are preferred over hidden vendoring.

## Testing Strategy

### Unit tests

- manifest parsing and invalid-input behavior
- ecosystem and workspace detection
- doctor capability gating
- finding fingerprints and deterministic ordering
- redaction
- reporter snapshots and schema behavior
- exit-threshold calculation

### Integration tests

- fixture repositories for Node and Python
- read-only scan with no subprocess execution
- explicit check execution with controlled passing and failing commands
- timeout and missing-executable behavior
- CLI text, JSON, and exit codes

### Security regression tests

- shell metacharacters remain arguments rather than executable syntax
- sensitive environment values are redacted
- output limits prevent unbounded capture
- path traversal cannot escape the scan root during manifest resolution
- `--run-checks` absence prevents all subprocess execution

## Versioning and Compatibility

- npm package versions follow semantic versioning.
- Doctor IDs and rule IDs are stable once published.
- JSON has its own `schemaVersion`.
- New optional fields are backward-compatible.
- Removed or reinterpreted fields require a schema-version change.
- External doctor SDK stability is not promised until `1.0.0`.

## Deferred Work

The following are intentionally outside `0.1.0`:

- Go, Rust, Java, and mobile check execution
- semantic code analysis implemented from scratch
- networked vulnerability databases
- SARIF and GitHub annotations
- baseline and diff comparison
- external doctor installation
- MCP server
- AI explanations and repair
- hosted dashboards, accounts, billing, and telemetry

This boundary keeps the first release useful, testable, safe, and honest.
