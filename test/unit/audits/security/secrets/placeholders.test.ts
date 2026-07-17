import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isPlaceholderSecret,
  isPlausibleSecretValue,
} from "../../../../../src/audits/security/secrets/placeholders.js";
import type { SecretMatch } from "../../../../../src/audits/security/secrets/types.js";

describe("secret placeholder classification", () => {
  const placeholderValues = [
    "",
    "short",
    "example",
    "dummy-secret-value",
    "placeholder-token-value",
    "change-me-before-use",
    "your_api_key_here",
    ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
    "${OPENAI_API_KEY}",
    "$DATABASE_URL",
    "process.env.API_KEY",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "abcabcabcabcabcabcabcabc",
  ];

  it.each(placeholderValues)("rejects the intentional placeholder %s", (value) => {
    expect(isPlaceholderSecret(value)).toBe(true);
    expect(isPlausibleSecretValue(value)).toBe(false);
  });

  const eligibleValues = [
    "N7v!2qL9#mR4xT8@pK6w",
    "p9B2x/7QmN4+vL8zR5cT1aW6",
    ["github", "_pat_", "11AA22bb33CC44dd55EE66ff77GG88hh"].join(""),
  ];

  it.each(eligibleValues)("keeps a varied non-placeholder value eligible", (value) => {
    expect(isPlaceholderSecret(value)).toBe(false);
    expect(isPlausibleSecretValue(value)).toBe(true);
  });

  it("requires adequate length and character variety", () => {
    expect(isPlausibleSecretValue("abcdefghijklmno")).toBe(false);
    expect(isPlausibleSecretValue("abcdefghijklmnop")).toBe(false);
    expect(isPlausibleSecretValue("Abcdefghijklmn1!")).toBe(true);
  });

  it("defines returned match metadata without a secret value field", () => {
    const match: SecretMatch = {
      detectorId: "github-token",
      family: "provider-token",
      line: 3,
      column: 10,
      assignmentName: "GITHUB_TOKEN",
      severity: "high",
      confidence: "high",
    };

    expect(match).not.toHaveProperty("value");
    expectTypeOf(match).toEqualTypeOf<SecretMatch>();
  });
});
