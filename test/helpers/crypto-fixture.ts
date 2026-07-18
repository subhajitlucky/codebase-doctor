import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestCertificateFixture {
  readonly privateKey: string;
  readonly certificate: string;
}

export function createTestCertificate(
  commonName: string,
  subjectAltName: string,
): TestCertificateFixture {
  const root = mkdtempSync(join(tmpdir(), "codebase-doctor-certificate-"));
  const keyPath = join(root, "key.pem");
  const certificatePath = join(root, "certificate.pem");
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      `/CN=${commonName}`,
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ], { stdio: "ignore" });
    return {
      privateKey: readFileSync(keyPath, "utf8"),
      certificate: readFileSync(certificatePath, "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
