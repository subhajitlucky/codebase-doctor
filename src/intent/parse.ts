/**
 * Intent documents are declared, structured claims — never interpreted prose.
 *
 * Supported sources:
 *   - a JSON file: { "intentVersion": "1", "summary": "...", "claims": [ ... ] }
 *   - markdown with one or more fenced ```intent blocks containing that JSON
 *
 * Prose outside the blocks is counted and reported as unstructured, because
 * intent that is not declared cannot be verified — and the doctor says so
 * instead of guessing.
 */

export type IntentClaim =
  | { id: string; kind: "rule-absent"; ruleId: string; pathPrefix?: string }
  | { id: string; kind: "rule-present"; ruleId: string; pathPrefix?: string }
  | { id: string; kind: "score-at-least"; value: number }
  | { id: string; kind: "coverage-complete" };

export interface ParsedIntent {
  summary?: string;
  claims: IntentClaim[];
  unstructuredCharacters: number;
}

export class IntentError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaim(value: unknown, index: number): IntentClaim {
  if (!isRecord(value)) {
    throw new IntentError(`claim ${index + 1} is not an object.`);
  }
  const id = typeof value.id === "string" && value.id.length > 0
    ? value.id
    : `claim-${index + 1}`;
  const kind = value.kind;
  if (kind === "rule-absent" || kind === "rule-present") {
    if (typeof value.ruleId !== "string" || value.ruleId.length === 0) {
      throw new IntentError(`claim "${id}" (${kind}) requires a ruleId.`);
    }
    return {
      id,
      kind,
      ruleId: value.ruleId,
      ...(typeof value.pathPrefix === "string" && value.pathPrefix.length > 0
        ? { pathPrefix: value.pathPrefix }
        : {}),
    };
  }
  if (kind === "score-at-least") {
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
      throw new IntentError(`claim "${id}" (score-at-least) requires a numeric value.`);
    }
    return { id, kind, value: value.value };
  }
  if (kind === "coverage-complete") {
    return { id, kind };
  }
  throw new IntentError(`claim "${id}" has an unsupported kind: ${String(kind)}.`);
}

function parseDocument(text: string, source: string): { summary?: string; claims: IntentClaim[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IntentError(`${source} is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new IntentError(`${source} must be a JSON object.`);
  }
  if (parsed.intentVersion !== "1") {
    throw new IntentError(`${source} has an unsupported intentVersion: ${String(parsed.intentVersion)}.`);
  }
  const rawClaims = parsed.claims;
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
    throw new IntentError(`${source} must declare at least one claim.`);
  }
  return {
    ...(typeof parsed.summary === "string" && parsed.summary.length > 0
      ? { summary: parsed.summary }
      : {}),
    claims: rawClaims.map(parseClaim),
  };
}

export function parseIntents(text: string, source = "intent"): ParsedIntent {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    return { ...parseDocument(text, source), unstructuredCharacters: 0 };
  }

  const blocks = [...text.matchAll(/```intent[^\n]*\n([\s\S]*?)```/gu)];
  if (blocks.length === 0) {
    throw new IntentError(
      `${source} contains no structured intent: expected JSON or a fenced \`\`\`intent block. ` +
      "Free-text intent is not interpreted.",
    );
  }

  const claims: IntentClaim[] = [];
  let summary: string | undefined;
  let consumed = 0;
  for (const block of blocks) {
    consumed += block[0].length;
    const document = parseDocument(block[1]!, `${source} (intent block)`);
    claims.push(...document.claims);
    summary = summary ?? document.summary;
  }

  return {
    ...(summary === undefined ? {} : { summary }),
    claims,
    unstructuredCharacters: text.length - consumed,
  };
}
