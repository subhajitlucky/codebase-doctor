import { describe, expect, it } from "vitest";
import { analyzeSecrets } from "../../../../../src/audits/security/secrets/analyzer.js";

const ALPHABET = "A7b9C2d8E4f6G1h3J5k0LqWrTyUiOpZx";

function generated(prefix: string, length = 32): string {
  let value = prefix;
  for (let index = 0; value.length < prefix.length + length; index += 1) {
    value += ALPHABET[index % ALPHABET.length];
  }
  return value;
}

describe("precision-first secret analysis", () => {
  it("detects a complete PEM private-key block", () => {
    const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const end = ["-----END ", "PRIVATE KEY-----"].join("");
    const matches = analyzeSecrets([begin, generated("", 64), end].join("\n"));

    expect(matches).toEqual([expect.objectContaining({
      detectorId: "pem-private-key",
      family: "private-key",
      line: 1,
      column: 1,
      severity: "high",
      confidence: "high",
    })]);
  });

  it.each([
    ["github-classic", "ghp_"],
    ["github-fine-grained", "github_pat_"],
    ["github-installation", "ghs_"],
    ["gitlab-personal", "glpat-"],
    ["slack-bot", "xoxb-"],
  ])("detects the %s provider prefix", (detectorId, prefix) => {
    const token = generated(prefix);
    const matches = analyzeSecrets(`TOKEN = "${token}"`);

    expect(matches).toContainEqual(expect.objectContaining({
      detectorId,
      family: "provider-token",
      line: 1,
      severity: "high",
      confidence: "high",
    }));
    expect(JSON.stringify(matches)).not.toContain(token);
  });

  it("accepts a variable-length GitHub installation-token shape", () => {
    const token = `${generated("ghs_", 20)}.${generated("", 24)}.${generated("", 24)}`;

    expect(analyzeSecrets(token)).toContainEqual(expect.objectContaining({
      detectorId: "github-installation",
      family: "provider-token",
    }));
  });

  it("requires an AWS access-key identifier and secret pair in the same file", () => {
    const accessKeyId = generated("AKIA", 16).slice(0, 20).toUpperCase();
    const secretAccessKey = generated("", 40);
    const matches = analyzeSecrets([
      `AWS_ACCESS_KEY_ID=${accessKeyId}`,
      `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
    ].join("\n"));

    expect(matches).toContainEqual(expect.objectContaining({
      detectorId: "aws-access-key-pair",
      family: "aws-credentials",
      line: 1,
      severity: "high",
      confidence: "high",
    }));
    expect(JSON.stringify(matches)).not.toContain(accessKeyId);
    expect(JSON.stringify(matches)).not.toContain(secretAccessKey);
    expect(analyzeSecrets(`AWS_ACCESS_KEY_ID=${accessKeyId}`))
      .not.toContainEqual(expect.objectContaining({ family: "aws-credentials" }));
  });

  it.each(["https", "postgresql", "mysql"])(
    "detects a credential-bearing %s URL",
    (scheme) => {
      const password = generated("", 24);
      const matches = analyzeSecrets(
        `DATABASE_URL="${scheme}://service:${password}@db.example.invalid/app"`,
      );

      expect(matches).toContainEqual(expect.objectContaining({
        detectorId: "credential-url",
        family: "credential-url",
        severity: "high",
        confidence: "high",
      }));
      expect(JSON.stringify(matches)).not.toContain(password);
    },
  );

  it.each([
    (value: string) => `API_KEY=${value}`,
    (value: string) => `export CLIENT_SECRET='${value}'`,
    (value: string) => `password: "${value}"`,
    (value: string) => `const accessToken = "${value}";`,
    (value: string) => `{"private_key":"${value}"}`,
  ])("detects a contextual sensitive assignment", (source) => {
    const secret = generated("", 24);
    const matches = analyzeSecrets(source(secret));

    expect(matches).toContainEqual(expect.objectContaining({
      family: "sensitive-assignment",
      severity: "medium",
      confidence: "medium",
    }));
    expect(JSON.stringify(matches)).not.toContain(secret);
  });

  it.each([
    "API_KEY=your_api_key_here",
    "TOKEN=${TOKEN}",
    "const password = randomBytes(24).toString(\"base64url\");",
    "{ DATABASE_URL: connectionString }",
    "const decodedPassword = safeDecode(url.password);",
    '"private-key": "Private key material is repository-shareable"',
    '{ DATABASE_URL: "postgres://audit:secret@db.test/app" }',
    "const checksum = \"sha512-A7b9C2d8E4f6G1h3J5k0LqWrTyUiOpZx\";",
    "id = \"550e8400-e29b-41d4-a716-446655440000\"",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 public@example.invalid",
    "https://example.invalid/path",
  ])("does not flag the non-secret example %s", (source) => {
    expect(analyzeSecrets(source)).toEqual([]);
  });

  it("keeps only the specific provider match when assignment rules overlap", () => {
    const token = generated("ghp_");
    const matches = analyzeSecrets(`GITHUB_TOKEN="${token}"`);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      detectorId: "github-classic",
      family: "provider-token",
    });
  });

  it("returns deterministic safe metadata without any seeded value", () => {
    const first = generated("glpat-");
    const second = generated("xoxb-");
    const source = `SLACK_TOKEN=${second}\nGITLAB_TOKEN=${first}`;

    const forward = analyzeSecrets(source);
    const repeated = analyzeSecrets(source);

    expect(repeated).toEqual(forward);
    expect(forward.map(({ line }) => line)).toEqual([1, 2]);
    expect(JSON.stringify(forward)).not.toContain(first);
    expect(JSON.stringify(forward)).not.toContain(second);
  });
});
