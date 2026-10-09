import { parse } from "@babel/parser";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../core/findings.js";
import { canonicalJson } from "../receipts/receipt.js";

export type WitnessKind = "sql-injection" | "command-injection" | "html-sink";

export const WITNESS_PAYLOADS: Record<WitnessKind, string> = {
  "sql-injection": "' OR '1'='1' --",
  "command-injection": "; echo codebase-doctor-witness",
  "html-sink": '<img src=x onerror="alert(1)">',
};

const EXPLANATIONS: Record<WitnessKind, string> = {
  "sql-injection":
    "the payload closes the string literal and makes the predicate a tautology, so the query returns every row",
  "command-injection":
    "the payload terminates the first command and appends a second one",
  "html-sink":
    "the browser parses the payload as HTML and executes the inline handler",
};

const KIND_BY_RULE: Record<string, WitnessKind> = {
  "backend/api/sql-string-concat-query": "sql-injection",
  "backend/api/child-process-exec-dynamic": "command-injection",
  "frontend/security/dangerously-set-inner-html": "html-sink",
};

const SINK_NAMES: Record<WitnessKind, string[]> = {
  "sql-injection": ["query", "execute"],
  "command-injection": ["exec", "execSync"],
  "html-sink": ["dangerouslySetInnerHTML"],
};

export interface WitnessArtifact {
  witnessVersion: "1";
  tool: { name: "codebase-doctor"; version: string };
  generatedAt: string;
  subject: {
    root: string;
    finding: { ruleId: string; fingerprint: string; location?: string };
  };
  witness: {
    kind: WitnessKind;
    payload: string;
    transformed: string;
    explanation: string;
    dynamicSegments: number;
  };
  digest: { algorithm: "sha256"; value: string };
}

export type WitnessOutcome =
  | { status: "synthesized"; artifact: WitnessArtifact }
  | { status: "undecided"; reason: string };

interface EvalState {
  substitutions: number;
}

type EvalResult = { ok: true; text: string } | { ok: false; reason: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/**
 * Evaluate a concatenation expression with every dynamic segment replaced by
 * the payload. Supported shapes: string/number literals, template literals,
 * binary `+`, parentheses, and TypeScript casts. Anything else is undecided —
 * never guessed.
 */
function evaluate(node: Node, payload: string, state: EvalState): EvalResult {
  switch (node?.type) {
    case "StringLiteral":
      return { ok: true, text: node.value };
    case "NumericLiteral":
      return { ok: true, text: String(node.value) };
    case "TemplateLiteral": {
      let text = "";
      for (let index = 0; index < node.quasis.length; index += 1) {
        text += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
        if (index < node.expressions.length) {
          const inner = evaluate(node.expressions[index], payload, state);
          if (!inner.ok) return inner;
          text += inner.text;
        }
      }
      return { ok: true, text };
    }
    case "BinaryExpression": {
      if (node.operator !== "+") {
        return { ok: false, reason: `unsupported operator "${node.operator}"` };
      }
      const left = evaluate(node.left, payload, state);
      const right = evaluate(node.right, payload, state);
      if (!left.ok) return left;
      if (!right.ok) return right;
      return { ok: true, text: left.text + right.text };
    }
    case "ParenthesizedExpression":
      return evaluate(node.expression, payload, state);
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
      return evaluate(node.expression, payload, state);
    case "Identifier":
    case "MemberExpression":
    case "OptionalMemberExpression":
    case "CallExpression":
    case "OptionalCallExpression":
    case "AwaitExpression":
    case "JSXExpressionContainer":
      state.substitutions += 1;
      return { ok: true, text: payload };
    default:
      return { ok: false, reason: `unsupported expression type "${String(node?.type)}"` };
  }
}

function calleeName(callee: Node): string | undefined {
  if (callee?.type === "Identifier") return callee.name;
  if (
    (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
    callee.computed !== true
  ) {
    return callee.property?.name;
  }
  return undefined;
}

function walk(node: Node, visit: (node: Node) => void): void {
  if (node === null || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, visit);
    } else if (value !== null && typeof value === "object") {
      walk(value, visit);
    }
  }
}

function parseSource(source: string): Node {
  return parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
    errorRecovery: true,
  });
}

function sinkArgumentFor(
  ast: Node,
  kind: WitnessKind,
  line: number | undefined,
): { expression: Node } | { reason: string } {
  const sinks = SINK_NAMES[kind];

  if (kind === "html-sink") {
    let fallback: Node | undefined;
    walk(ast, (node) => {
      if (node.type !== "JSXAttribute") return;
      if (node.name?.name !== sinks[0]) return;
      fallback ??= node;
      if (line !== undefined && node.loc?.start?.line === line) {
        fallback = node;
      }
    });
    if (fallback === undefined) {
      return { reason: "the dangerouslySetInnerHTML attribute was not found in the file" };
    }
    const expression = fallback.value?.expression;
    if (expression?.type !== "ObjectExpression") {
      return { reason: "the attribute value is not an inline object with __html" };
    }
    const property = (expression.properties ?? []).find(
      (entry: Node) => entry.type === "ObjectProperty" && entry.key?.name === "__html",
    );
    if (property?.value === undefined) {
      return { reason: "the attribute object has no __html property" };
    }
    return { expression: property.value };
  }

  let found: Node | undefined;
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const name = calleeName(node.callee);
    if (name === undefined || !sinks.includes(name)) return;
    if (line !== undefined && node.loc?.start?.line === line) {
      found = node;
    } else if (found === undefined && line === undefined) {
      found = node;
    }
  });
  if (found === undefined) {
    return { reason: `no ${sinks.join("/")} call was found on the finding line` };
  }
  const argument = found.arguments?.[0];
  if (argument === undefined) {
    return { reason: "the call has no first argument to evaluate" };
  }
  return { expression: argument };
}

export interface SynthesizeOptions {
  toolVersion: string;
  generatedAt?: Date;
}

/**
 * Synthesize a concrete exploit witness for an injection-class finding:
 * the payload, the transformed sink text it produces, and why the
 * transformation is a violation. Decidable shapes only; anything else is
 * undecided.
 */
export async function synthesizeWitness(
  root: string,
  finding: Finding,
  options: SynthesizeOptions,
): Promise<WitnessOutcome> {
  const kind = KIND_BY_RULE[finding.ruleId];
  if (kind === undefined) {
    return { status: "undecided", reason: `no witness synthesizer for rule "${finding.ruleId}"` };
  }
  if (finding.location === undefined) {
    return { status: "undecided", reason: "the finding has no file location" };
  }

  let source: string;
  try {
    source = await readFile(join(root, ...finding.location.path.split("/")), "utf8");
  } catch {
    return { status: "undecided", reason: `could not read ${finding.location.path}` };
  }

  let ast: Node;
  try {
    ast = parseSource(source);
  } catch (error) {
    return {
      status: "undecided",
      reason: `could not parse ${finding.location.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const target = sinkArgumentFor(ast, kind, finding.location.line);
  if ("reason" in target) {
    return { status: "undecided", reason: target.reason };
  }

  const payload = WITNESS_PAYLOADS[kind];
  const state: EvalState = { substitutions: 0 };
  const evaluated = evaluate(target.expression, payload, state);
  if (!evaluated.ok) {
    return { status: "undecided", reason: evaluated.reason };
  }
  if (state.substitutions === 0) {
    return { status: "undecided", reason: "the sink argument contains no dynamic segment" };
  }

  const body = {
    witnessVersion: "1" as const,
    tool: { name: "codebase-doctor" as const, version: options.toolVersion },
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    subject: {
      root,
      finding: {
        ruleId: finding.ruleId,
        fingerprint: finding.fingerprint,
        ...(finding.location === undefined
          ? {}
          : {
              location: `${finding.location.path}${
                finding.location.line === undefined ? "" : `:${finding.location.line}`
              }`,
            }),
      },
    },
    witness: {
      kind,
      payload,
      transformed: evaluated.text,
      explanation: EXPLANATIONS[kind],
      dynamicSegments: state.substitutions,
    },
  };
  return {
    status: "synthesized",
    artifact: {
      ...body,
      digest: {
        algorithm: "sha256",
        value: createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"),
      },
    },
  };
}

export function renderWitnessText(artifact: WitnessArtifact): string {
  return [
    "Codebase Doctor Exploit Witness",
    "===============================",
    "",
    `Finding: ${artifact.subject.finding.ruleId} ${artifact.subject.finding.location ?? ""}`,
    `Fingerprint: ${artifact.subject.finding.fingerprint}`,
    "",
    `Payload:     ${artifact.witness.payload}`,
    `Transformed: ${artifact.witness.transformed}`,
    `Why:         ${artifact.witness.explanation}`,
    `Dynamic segments replaced: ${artifact.witness.dynamicSegments}`,
    "",
    "The transformed sink text is computed statically from the call expression.",
    "The witness is bound to the finding fingerprint and never executed.",
    "",
  ].join("\n");
}
