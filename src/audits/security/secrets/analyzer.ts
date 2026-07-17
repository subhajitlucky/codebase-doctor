import { PROVIDER_SECRET_PATTERNS } from "./catalog.js";
import { isPlaceholderSecret, isPlausibleSecretValue } from "./placeholders.js";
import type { SecretMatch } from "./types.js";

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly priority: number;
  readonly match: SecretMatch;
}

function locationAt(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - lastNewline,
  };
}

function safeMatch(
  content: string,
  offset: number,
  fields: Omit<SecretMatch, "line" | "column">,
): SecretMatch {
  return { ...fields, ...locationAt(content, offset) };
}

function providerCandidates(content: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const pattern of PROVIDER_SECRET_PATTERNS) {
    pattern.expression.lastIndex = 0;
    for (const found of content.matchAll(pattern.expression)) {
      const value = found[0];
      const start = found.index;
      if (isPlaceholderSecret(value) || !isPlausibleSecretValue(value)) continue;
      candidates.push({
        start,
        end: start + value.length,
        priority: 5,
        match: safeMatch(content, start, {
          detectorId: pattern.detectorId,
          family: "provider-token",
          severity: "high",
          confidence: "high",
        }),
      });
    }
  }
  return candidates;
}

function privateKeyCandidates(content: string): Candidate[] {
  const candidates: Candidate[] = [];
  const beginExpression = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY)-----/gu;
  for (const found of content.matchAll(beginExpression)) {
    const start = found.index;
    const label = found[1];
    if (label === undefined) continue;
    const endMarker = `-----END ${label}-----`;
    const markerStart = content.indexOf(endMarker, start + found[0].length);
    if (markerStart < 0) continue;
    candidates.push({
      start,
      end: markerStart + endMarker.length,
      priority: 6,
      match: safeMatch(content, start, {
        detectorId: "pem-private-key",
        family: "private-key",
        severity: "high",
        confidence: "high",
      }),
    });
  }
  return candidates;
}

function awsCandidates(content: string): Candidate[] {
  const accessIds = [...content.matchAll(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu)]
    .filter(({ 0: value }) => !isPlaceholderSecret(value));
  if (accessIds.length === 0) return [];

  const secretExpression = /\bAWS_SECRET_ACCESS_KEY\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/giu;
  const secret = [...content.matchAll(secretExpression)].find((found) => {
    const value = found[1];
    return value !== undefined && isPlausibleSecretValue(value);
  });
  if (secret === undefined) return [];

  return accessIds.map((found) => {
    const start = found.index;
    return {
      start,
      end: start + found[0].length,
      priority: 5,
      match: safeMatch(content, start, {
        detectorId: "aws-access-key-pair",
        family: "aws-credentials",
        severity: "high",
        confidence: "high",
      }),
    };
  });
}

function credentialUrlCandidates(content: string): Candidate[] {
  const candidates: Candidate[] = [];
  const expression = /\b(?:https?|postgres(?:ql)?|mysql):\/\/[^\s:@/]+:([^\s@/]+)@[^\s"'<>]+/giu;
  for (const found of content.matchAll(expression)) {
    const password = found[1];
    if (password === undefined || !isPlausibleSecretValue(password)) continue;
    const relativeStart = found[0].indexOf(password);
    const start = found.index + relativeStart;
    candidates.push({
      start,
      end: start + password.length,
      priority: 4,
      match: safeMatch(content, start, {
        detectorId: "credential-url",
        family: "credential-url",
        severity: "high",
        confidence: "high",
      }),
    });
  }
  return candidates;
}

function assignmentCandidates(content: string): Candidate[] {
  const candidates: Candidate[] = [];
  const name = "(?:api[_-]?key|client[_-]?secret|password|private[_-]?key|access[_-]?token|auth[_-]?token|database[_-]?url|github[_-]?token|gitlab[_-]?token|slack[_-]?token)";
  const expression = new RegExp(
    `(?:\\b(?:const|let|var|export)\\s+)?["']?\\b(${name})["']?\\s*[:=]\\s*(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)'|([^\\s#;,}\\r\\n]+))`,
    "giu",
  );
  for (const found of content.matchAll(expression)) {
    const assignmentName = found[1];
    const value = found[2] ?? found[3] ?? found[4];
    const isUnquoted = found[4] !== undefined;
    const isUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value ?? "");
    const isConservativeUnquotedLiteral = value !== undefined &&
      /^[A-Za-z0-9_/@+=$!%*-]+$/u.test(value) &&
      (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) || /[0-9]/u.test(value));
    if (
      assignmentName === undefined ||
      value === undefined ||
      isUrl ||
      (isUnquoted && !isConservativeUnquotedLiteral) ||
      !isPlausibleSecretValue(value)
    ) {
      continue;
    }
    const relativeStart = found[0].lastIndexOf(value);
    const start = found.index + relativeStart;
    candidates.push({
      start,
      end: start + value.length,
      priority: 1,
      match: safeMatch(content, start, {
        detectorId: "sensitive-assignment",
        family: "sensitive-assignment",
        assignmentName,
        severity: "medium",
        confidence: "medium",
      }),
    });
  }
  return candidates;
}

function overlaps(left: Candidate, right: Candidate): boolean {
  return left.start < right.end && right.start < left.end;
}

export function analyzeSecrets(content: string): SecretMatch[] {
  const bySpecificity = [
    ...privateKeyCandidates(content),
    ...providerCandidates(content),
    ...awsCandidates(content),
    ...credentialUrlCandidates(content),
    ...assignmentCandidates(content),
  ].sort((left, right) =>
    right.priority - left.priority || left.start - right.start || left.end - right.end
  );
  const selected: Candidate[] = [];
  for (const candidate of bySpecificity) {
    if (!selected.some((current) => overlaps(candidate, current))) selected.push(candidate);
  }
  return selected
    .sort((left, right) =>
      left.match.line - right.match.line ||
      left.match.column - right.match.column ||
      left.match.detectorId.localeCompare(right.match.detectorId)
    )
    .map(({ match }) => ({ ...match }));
}
