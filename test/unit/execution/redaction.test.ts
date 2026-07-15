import { describe, expect, it } from "vitest";
import { redactText } from "../../../src/execution/redaction.js";

describe("output redaction", () => {
  it("removes credentials embedded in URLs", () => {
    const redacted = redactText("fetch failed: https://alice:secret-pass@example.com/private");

    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("secret-pass");
    expect(redacted).toContain("example.com/private");
  });

  it("removes sensitive environment fixture values", () => {
    const redacted = redactText(
      "token=token-value secret=secret-value password=password-value api=api-key-value",
      {
        GITHUB_TOKEN: "token-value",
        CLIENT_SECRET: "secret-value",
        DB_PASSWORD: "password-value",
        OPENAI_API_KEY: "api-key-value",
        HARMLESS_NAME: "keep-me",
      },
    );

    expect(redacted).not.toMatch(/token-value|secret-value|password-value|api-key-value/);
    expect(redacted).toContain("token=[REDACTED]");
  });

  it("redacts common bearer and API key shapes", () => {
    const redacted = redactText(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.1234567890 token sk-abcdefghijklmnopqrstuvwxyz123456",
    );

    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toContain("Bearer [REDACTED]");
  });

  it("keeps harmless paths and error messages readable", () => {
    const message = "Error: expected value at /home/user/project/src/index.ts:12";

    expect(redactText(message)).toBe(message);
  });
});
