const SENSITIVE_ENVIRONMENT_KEY =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)/i;

function sensitiveValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => SENSITIVE_ENVIRONMENT_KEY.test(key) && value !== undefined && value.length > 0)
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
}

/** Best-effort removal of known credential shapes; it is not a perfect secret detector. */
export function redactText(text: string, environment: NodeJS.ProcessEnv = {}): string {
  let redacted = text;

  for (const value of sensitiveValues(environment)) {
    redacted = redacted.split(value).join("[REDACTED]");
  }

  redacted = redacted.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
    "$1[REDACTED]@",
  );
  redacted = redacted.replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    "$1[REDACTED]",
  );
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");

  return redacted;
}
