import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyLocalhostTestKeys } from "../../../../../src/audits/security/secrets/local-test-key.js";
import { createTestCertificate } from "../../../../helpers/crypto-fixture.js";

describe("localhost test private-key classification", () => {
  it("recognizes a matching key with localhost-only certificate identities", () => {
    const fixture = createTestCertificate("localhost", "DNS:localhost,IP:127.0.0.1,IP:::1");

    expect(classifyLocalhostTestKeys(fixture.privateKey, [fixture.certificate])).toEqual([{
      line: 1,
      column: 1,
    }]);
  });

  it("does not recognize a matching certificate with a non-local identity", () => {
    const fixture = createTestCertificate(
      "localhost",
      "DNS:localhost,DNS:service.example.invalid,IP:127.0.0.1",
    );

    expect(classifyLocalhostTestKeys(fixture.privateKey, [fixture.certificate])).toEqual([]);
  });

  it("does not recognize an unmatched certificate or a key without a certificate", () => {
    const keyFixture = createTestCertificate("localhost", "DNS:localhost");
    const otherFixture = createTestCertificate("localhost", "DNS:localhost,IP:127.0.0.1");

    expect(classifyLocalhostTestKeys(keyFixture.privateKey, [otherFixture.certificate])).toEqual([]);
    expect(classifyLocalhostTestKeys(keyFixture.privateKey, [])).toEqual([]);
  });

  it("never serializes key material or derived public-key bytes", () => {
    const fixture = createTestCertificate("localhost", "DNS:localhost");
    const publicDer = createPublicKey(createPrivateKey(fixture.privateKey)).export({
      type: "spki",
      format: "der",
    }).toString("base64");
    const result = classifyLocalhostTestKeys(fixture.privateKey, [fixture.certificate]);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(fixture.privateKey.trim());
    expect(serialized).not.toContain(publicDer);
  });
});
