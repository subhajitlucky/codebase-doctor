import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { posix } from "node:path";
import type { LocalTestKeyLocation } from "./types.js";

const PRIVATE_KEY_PATTERN = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu;
const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;
const CERTIFICATE_EXTENSIONS = new Set([".cer", ".crt", ".pem"]);

function locationAt(content: string, offset: number): LocalTestKeyLocation {
  const before = content.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - lastNewline,
  };
}

function loopbackIp(value: string): boolean {
  const version = isIP(value);
  if (version === 4) return value.split(".")[0] === "127";
  if (version !== 6) return false;
  return value.toLowerCase() === "::1" ||
    value.toLowerCase() === "0:0:0:0:0:0:0:1";
}

function localSubject(cert: X509Certificate): boolean {
  const commonNames = cert.subject
    .split("\n")
    .filter((entry) => entry.startsWith("CN="))
    .map((entry) => entry.slice(3));
  return commonNames.length === 0 ||
    commonNames.every((name) => name.toLowerCase() === "localhost");
}

function localSubjectAltNames(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) return false;
  if (value.includes("\"") || value.includes("\\")) return false;
  const identities = value.split(", ");
  if (identities.length === 0) return false;
  return identities.every((identity) => {
    if (identity.startsWith("DNS:")) {
      return identity.slice(4).toLowerCase() === "localhost";
    }
    if (identity.startsWith("IP Address:")) {
      return loopbackIp(identity.slice("IP Address:".length));
    }
    return false;
  });
}

function localhostOnly(cert: X509Certificate): boolean {
  if (!localSubject(cert)) return false;
  if (cert.subjectAltName !== undefined) return localSubjectAltNames(cert.subjectAltName);
  return cert.subject.split("\n").some((entry) => entry.toLowerCase() === "cn=localhost");
}

function publicKeyDigest(value: ReturnType<typeof createPrivateKey> | X509Certificate): Buffer {
  const publicKey = value instanceof X509Certificate
    ? value.publicKey
    : createPublicKey(value);
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest();
}

function localCertificateDigests(contents: readonly string[]): Buffer[] {
  const digests: Buffer[] = [];
  for (const content of contents) {
    for (const found of content.matchAll(CERTIFICATE_PATTERN)) {
      try {
        const certificate = new X509Certificate(found[0]);
        if (localhostOnly(certificate)) digests.push(publicKeyDigest(certificate));
      } catch {
        // Malformed or unsupported certificates never suppress a finding.
      }
    }
  }
  return digests;
}

export function isCertificateCandidatePath(path: string): boolean {
  return CERTIFICATE_EXTENSIONS.has(posix.extname(path).toLowerCase());
}

export function classifyLocalhostTestKeys(
  keyContent: string,
  certificateContents: readonly string[],
): LocalTestKeyLocation[] {
  const certificateDigests = localCertificateDigests(certificateContents);
  if (certificateDigests.length === 0) return [];
  const locations: LocalTestKeyLocation[] = [];
  for (const found of keyContent.matchAll(PRIVATE_KEY_PATTERN)) {
    try {
      const digest = publicKeyDigest(createPrivateKey(found[0]));
      if (certificateDigests.some((candidate) =>
        candidate.byteLength === digest.byteLength && timingSafeEqual(candidate, digest)
      )) {
        locations.push(locationAt(keyContent, found.index));
      }
    } catch {
      // Unparseable or encrypted keys remain findings.
    }
  }
  return locations;
}
