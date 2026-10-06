const PLACEHOLDER_WORDS = [
  "example",
  "dummy",
  "placeholder",
  "changeme",
  "change-me",
  "yourkeyhere",
  "your-key-here",
  "yourapikeyhere",
  "your-api-key-here",
  "test-only",
] as const;

function isRepeatedSequence(value: string): boolean {
  for (let width = 1; width <= Math.min(8, Math.floor(value.length / 3)); width += 1) {
    if (value.length % width !== 0) continue;
    const unit = value.slice(0, width);
    if (unit.repeat(value.length / width) === value) return true;
  }
  return false;
}

// Synthetic keyboard/alphabet tokens ("abcdef...", "0123456789...") are never
// real credentials: a random credential with an 8+ ascending or descending run
// is astronomically unlikely, while hand-typed fixtures use them constantly.
const MIN_SEQUENTIAL_RUN = 8;

function longestSequentialRun(value: string): number {
  const chars = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  let longest = 1;
  let current = 1;
  let direction = 0;
  for (let index = 1; index < chars.length; index += 1) {
    const step = chars[index]!.charCodeAt(0) - chars[index - 1]!.charCodeAt(0);
    const stepDirection = step === 1 ? 1 : step === -1 ? -1 : 0;
    if (stepDirection !== 0 && stepDirection === direction) {
      current += 1;
    } else if (stepDirection !== 0) {
      direction = stepDirection;
      current = 2;
    } else {
      direction = 0;
      current = 1;
    }
    longest = Math.max(longest, current);
  }
  return longest;
}

export function isPlaceholderSecret(rawValue: string): boolean {
  const value = rawValue.trim();
  if (value.length < 8) return true;
  if (
    /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(value) ||
    /^(?:process\.env|import\.meta\.env)\.[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
  ) {
    return true;
  }

  const lower = value.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/gu, "");
  if (PLACEHOLDER_WORDS.some((word) => {
    const compactWord = word.replace(/[^a-z0-9]/gu, "");
    return lower.includes(word) || compact.includes(compactWord);
  })) {
    return true;
  }
  if (longestSequentialRun(value) >= MIN_SEQUENTIAL_RUN) return true;
  return isRepeatedSequence(value);
}

export function isPlausibleSecretValue(value: string): boolean {
  if (value.length < 16 || /\s/u.test(value) || isPlaceholderSecret(value)) return false;
  if (new Set(value).size < 8) return false;
  const characterClasses = [
    /[a-z]/u,
    /[A-Z]/u,
    /[0-9]/u,
    /[^A-Za-z0-9]/u,
  ].filter((expression) => expression.test(value)).length;
  return characterClasses >= 2;
}
