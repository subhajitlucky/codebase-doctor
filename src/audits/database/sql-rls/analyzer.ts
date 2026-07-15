import {
  createFingerprint,
  sortFindings,
  type Confidence,
  type Evidence,
  type Finding,
  type Severity,
} from "../../../core/findings.js";
import type {
  SqlPolicyCommand,
  SqlStatement,
  SqlStreamState,
  StaticPolicyState,
  StaticTableState,
} from "./types.js";

const DOCTOR_ID = "database/sql-rls";
const publicLikeRoles = new Set(["public", "anon", "anonymous"]);
const applicationRoles = new Set(["public", "anon", "anonymous", "authenticated"]);
const rowPrivileges = new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]);
const concreteCommands: Exclude<SqlPolicyCommand, "ALL">[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

interface FindingOptions {
  rule: string;
  severity: Severity;
  confidence?: Confidence;
  title: string;
  message: string;
  remediation: string;
  evidence: SqlStatement;
  policy?: string;
  identity?: readonly unknown[];
}

function qualifiedName(table: StaticTableState): string {
  return `${table.schema}.${table.name}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteTable(table: StaticTableState): string {
  return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
}

function finding(streamId: string, table: StaticTableState, options: FindingOptions): Finding {
  const ruleId = `${DOCTOR_ID}/${options.rule}`;
  const databaseEvidence: Evidence = {
    type: "database",
    schema: table.schema,
    table: table.name,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    detail: options.message,
  };
  return {
    ruleId,
    doctorId: DOCTOR_ID,
    severity: options.severity,
    confidence: options.confidence ?? "high",
    category: "database-security",
    title: options.title,
    message: options.message,
    location: { path: options.evidence.path, line: options.evidence.startLine },
    evidence: [
      databaseEvidence,
      { type: "file", path: options.evidence.path, detail: `SQL statement at line ${options.evidence.startLine}.` },
    ],
    remediation: options.remediation,
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId,
      identity: JSON.stringify([
        streamId,
        table.schema,
        table.name,
        options.policy ?? null,
        ...(options.identity ?? []),
      ]),
    }),
  };
}

function isUnconditionalExpression(expression: string | null): boolean {
  if (expression === null) return true;
  const normalized = expression.replace(/[()]/g, "").trim().toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "1 = 1" || normalized === "1=1";
}

function knownPolicy(policy: StaticPolicyState): policy is StaticPolicyState & {
  command: SqlPolicyCommand;
  permissive: boolean;
  roles: readonly string[];
  usingExpression: string | null;
  checkExpression: string | null;
} {
  return policy.command !== "unknown" &&
    policy.permissive !== "unknown" &&
    policy.roles !== "unknown" &&
    policy.usingExpression !== "unknown" &&
    policy.checkExpression !== "unknown";
}

function effectiveCheck(policy: StaticPolicyState & {
  command: SqlPolicyCommand;
  usingExpression: string | null;
  checkExpression: string | null;
}): string | null {
  if (policy.checkExpression !== null) return policy.checkExpression;
  return policy.command === "UPDATE" || policy.command === "ALL"
    ? policy.usingExpression
    : null;
}

function hasUnconditionalWrite(policy: StaticPolicyState & {
  command: SqlPolicyCommand;
  usingExpression: string | null;
  checkExpression: string | null;
}): boolean {
  switch (policy.command) {
    case "SELECT": return false;
    case "INSERT": return isUnconditionalExpression(effectiveCheck(policy));
    case "UPDATE":
    case "ALL":
      return isUnconditionalExpression(policy.usingExpression) || isUnconditionalExpression(effectiveCheck(policy));
    case "DELETE": return isUnconditionalExpression(policy.usingExpression);
  }
}

function missingWriteCheck(policy: StaticPolicyState & {
  command: SqlPolicyCommand;
  usingExpression: string | null;
  checkExpression: string | null;
}): boolean {
  if (policy.checkExpression !== null || policy.command === "SELECT" || policy.command === "DELETE") return false;
  return isUnconditionalExpression(effectiveCheck(policy));
}

function analyzePolicy(streamId: string, table: StaticTableState, policy: StaticPolicyState): Finding[] {
  if (!knownPolicy(policy)) return [];
  const findings: Finding[] = [];
  const publicLike = policy.roles.some((role) => publicLikeRoles.has(role.toLowerCase()));
  const applicationFacing = policy.roles.some((role) => applicationRoles.has(role.toLowerCase()));
  const reads = policy.command === "SELECT" || policy.command === "ALL";
  const writes = policy.command !== "SELECT";

  if (publicLike && reads && isUnconditionalExpression(policy.usingExpression)) {
    findings.push(finding(streamId, table, {
      rule: "public-unconditional-read",
      severity: "high",
      title: "Public-like role can read rows unconditionally",
      message: `Policy "${policy.name}" grants ${policy.command} to ${policy.roles.join(", ")} without a limiting row predicate.`,
      remediation: `Restrict the policy with an ownership, tenant, or explicit public-content predicate.`,
      evidence: policy.usingEvidence ?? policy.evidence,
      policy: policy.name,
      identity: [policy.command, "read"],
    }));
  }

  if (publicLike && writes && hasUnconditionalWrite(policy)) {
    findings.push(finding(streamId, table, {
      rule: "public-unconditional-write",
      severity: "critical",
      title: "Public-like role can write rows too broadly",
      message: `Policy "${policy.name}" allows ${policy.command} for ${policy.roles.join(", ")} with an unconditional write predicate.`,
      remediation: `Require authenticated ownership constraints in USING and WITH CHECK.`,
      evidence: policy.checkEvidence ?? policy.usingEvidence ?? policy.evidence,
      policy: policy.name,
      identity: [policy.command, "write"],
    }));
  }

  if (applicationFacing && missingWriteCheck(policy)) {
    findings.push(finding(streamId, table, {
      rule: "write-policy-missing-check",
      severity: "medium",
      title: "Write policy has no effective row check",
      message: `Policy "${policy.name}" handles ${policy.command} without an effective insert or update constraint.`,
      remediation: `Add WITH CHECK so inserted or changed rows must satisfy the intended ownership and tenant boundary.`,
      evidence: policy.checkEvidence ?? policy.usingEvidence ?? policy.evidence,
      policy: policy.name,
      identity: [policy.command],
    }));
  } else if (applicationFacing && writes && isUnconditionalExpression(effectiveCheck(policy))) {
    findings.push(finding(streamId, table, {
      rule: "write-policy-unconditional-check",
      severity: "medium",
      title: "Write policy check is unconditional",
      message: `Policy "${policy.name}" has an effectively unconditional check for ${policy.command}.`,
      remediation: `Replace the unconditional check with an ownership or tenant constraint.`,
      evidence: policy.checkEvidence ?? policy.evidence,
      policy: policy.name,
      identity: [policy.command],
    }));
  }

  if (policy.permissive && publicLike) {
    findings.push(finding(streamId, table, {
      rule: "public-permissive-policy",
      severity: "low",
      title: "Public-like role uses a permissive policy",
      message: `Policy "${policy.name}" is OR-combined with other permissive policies for a public-like role.`,
      remediation: `Review whether the policy should be restrictive or limited to authenticated roles.`,
      evidence: policy.rolesEvidence ?? policy.evidence,
      policy: policy.name,
      identity: [policy.command],
    }));
  }

  return findings;
}

function compositionFindings(streamId: string, table: StaticTableState): Finding[] {
  const known = table.policies.filter(knownPolicy);
  const namedRoles = new Set(known.flatMap((policy) =>
    policy.roles.filter((role) => role.toLowerCase() !== "public")
  ));
  const groups = new Map<string, StaticPolicyState[]>();
  for (const policy of known.filter((candidate) => candidate.permissive)) {
    const commands = policy.command === "ALL" ? concreteCommands : [policy.command];
    const roles = policy.roles.some((role) => role.toLowerCase() === "public")
      ? new Set(["public", ...namedRoles])
      : new Set(policy.roles);
    for (const role of roles) {
      for (const command of commands) {
        const key = `${role.toLowerCase()}\u0000${command}`;
        const existing = groups.get(key) ?? [];
        existing.push(policy);
        groups.set(key, existing);
      }
    }
  }
  const findings: Finding[] = [];
  for (const [key, policies] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const unique = [...new Map(policies.map((policy) => [policy.name, policy])).values()]
      .sort((left, right) => left.name.localeCompare(right.name));
    if (unique.length < 2) continue;
    const [role, command] = key.split("\u0000") as [string, string];
    findings.push(finding(streamId, table, {
      rule: "multiple-permissive-policies",
      severity: "medium",
      confidence: "high",
      title: "Multiple permissive policies combine for one role and command",
      message: `Role ${role} has ${unique.length} permissive policies for ${command}: ${unique.map(({ name }) => `"${name}"`).join(", ")}. Their predicates are OR-combined.`,
      remediation: `Review the policies together and confirm that access allowed by any one policy is intended.`,
      evidence: unique[0]!.evidence,
      identity: [role, command, unique.map(({ name }) => name)],
    }));
  }
  return findings;
}

function analyzeTable(streamId: string, table: StaticTableState): Finding[] {
  if (table.dropped) return [];
  const findings: Finding[] = [];
  const applicationGrants = table.grants.filter(({ role }) => applicationRoles.has(role.toLowerCase()));
  const truncate = applicationGrants.find(({ privilege }) => privilege === "TRUNCATE");
  if (truncate !== undefined) {
    findings.push(finding(streamId, table, {
      rule: "reachable-truncate",
      severity: "high",
      title: "TRUNCATE is granted to an application-facing role",
      message: `${qualifiedName(table)} grants TRUNCATE directly to ${truncate.role}. RLS never protects TRUNCATE.`,
      remediation: `Revoke TRUNCATE from application-facing roles and reserve it for isolated maintenance roles.`,
      evidence: truncate.evidence,
      identity: [truncate.role, truncate.privilege],
    }));
  }

  if (table.rlsEnabled === false) {
    const exposure = applicationGrants.find(({ privilege }) => rowPrivileges.has(privilege));
    findings.push(finding(streamId, table, exposure === undefined ? {
      rule: "rls-disabled",
      severity: "medium",
      title: "Row Level Security is disabled",
      message: `${qualifiedName(table)} is explicitly expected to have RLS disabled.`,
      remediation: `Run: alter table ${quoteTable(table)} enable row level security;`,
      evidence: table.rlsEvidence ?? table.lastEvidence,
    } : {
      rule: "rls-disabled-exposed",
      severity: "high",
      title: "RLS-disabled table has application-facing access",
      message: `${qualifiedName(table)} has RLS disabled and grants ${exposure.privilege} directly to ${exposure.role}.`,
      remediation: `Enable RLS and add least-privilege policies before granting application access.`,
      evidence: exposure.evidence,
      identity: [exposure.role, exposure.privilege],
    }));
    return findings;
  }

  if (table.rlsEnabled !== true) return findings;
  if (table.policiesComplete && table.policies.length === 0) {
    findings.push(finding(streamId, table, {
      rule: "rls-enabled-no-policies",
      severity: "medium",
      title: "RLS is enabled but no policies exist",
      message: `${qualifiedName(table)} will default-deny non-owner access because its reconstructed policy set is empty.`,
      remediation: `Add explicit least-privilege policies for required application commands.`,
      evidence: table.rlsEvidence ?? table.lastEvidence,
    }));
  }
  if (table.forceRls === false) {
    findings.push(finding(streamId, table, {
      rule: "force-rls-disabled",
      severity: "info",
      title: "FORCE ROW LEVEL SECURITY is disabled",
      message: `${qualifiedName(table)} does not force its owner through RLS policies.`,
      remediation: `After validating owner workflows, run: alter table ${quoteTable(table)} force row level security;`,
      evidence: table.forceRlsEvidence ?? table.lastEvidence,
    }));
  }
  for (const policy of table.policies) findings.push(...analyzePolicy(streamId, table, policy));
  findings.push(...compositionFindings(streamId, table));
  return findings;
}

export function analyzeStaticSqlRls(state: SqlStreamState): Finding[] {
  return sortFindings(state.tables.flatMap((table) => analyzeTable(state.streamId, table)));
}
