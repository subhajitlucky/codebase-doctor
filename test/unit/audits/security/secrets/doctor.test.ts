import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createSecretsDoctor } from "../../../../../src/audits/security/secrets/doctor.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../../src/workspace/types.js";
import { createTestCertificate } from "../../../../helpers/crypto-fixture.js";

const ALPHABET = "Q7w9E2r8T4y6U1i3O5p0AsDfGhJkLzXc";

function token(prefix: string, length = 32): string {
  let value = prefix;
  for (let index = 0; value.length < prefix.length + length; index += 1) {
    value += ALPHABET[index % ALPHABET.length];
  }
  return value;
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    root: "/repo",
    files: [{ path: "src/config.ts", kind: "file", size: 100 }],
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
    repositoryFiles: {
      availability: "available",
      paths: ["src/config.ts"],
      limitations: [],
    },
    ...overrides,
  };
}

describe("Secrets Doctor", () => {
  it("is an always-available read-only built-in Doctor", async () => {
    const doctor = createSecretsDoctor({ readFile: async () => Buffer.from("") });

    expect(doctor).toMatchObject({
      id: "security/secrets",
      version: "0.1.0",
      capabilities: ["filesystem:read"],
    });
    expect(await doctor.supports(snapshot())).toBe(true);
  });

  it("returns deterministic redacted findings and completed coverage", async () => {
    const seededSecret = token("ghp_");
    const readFile = vi.fn(async () => Buffer.from(`GITHUB_TOKEN="${seededSecret}"\n`));
    const doctor = createSecretsDoctor({ readFile });

    const result = await doctor.diagnose({
      snapshot: snapshot(),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).toHaveBeenCalledWith("/repo/src/config.ts");
    expect(result.status).toBe("completed");
    expect(result.coverage).toEqual([{
      moduleId: "security/secrets",
      status: "completed",
      scope: "full",
      filesExamined: 1,
      statementsExamined: 1,
      statementsRecognized: 1,
      limitations: [],
    }]);
    expect(result.findings).toEqual([expect.objectContaining({
      ruleId: "security/secrets/provider-token",
      doctorId: "security/secrets",
      severity: "high",
      confidence: "high",
      category: "security",
      location: { path: "src/config.ts", line: 1, column: 15 },
      evidence: [{
        type: "file",
        path: "src/config.ts",
        detail: "A github-classic credential pattern matched; the value was withheld.",
      }],
    })]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(seededSecret);
    expect(result.findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses an inventoried unchanged certificate to classify a changed localhost test key", async () => {
    const fixture = createTestCertificate("localhost", "DNS:localhost,IP:127.0.0.1");
    const contents = new Map([
      ["/repo/test/key.pem", Buffer.from(fixture.privateKey)],
      ["/repo/test/certificate.pem", Buffer.from(fixture.certificate)],
    ]);
    const readFile = vi.fn(async (path: string) => {
      const content = contents.get(path);
      if (content === undefined) throw new Error("unexpected path");
      return content;
    });
    const doctor = createSecretsDoctor({ readFile });
    const result = await doctor.diagnose({
      snapshot: snapshot({
        files: [
          { path: "test/certificate.pem", kind: "file", size: Buffer.byteLength(fixture.certificate) },
          { path: "test/key.pem", kind: "file", size: Buffer.byteLength(fixture.privateKey) },
        ],
        repositoryFiles: {
          availability: "available",
          paths: ["test/certificate.pem", "test/key.pem"],
          limitations: [],
        },
        auditScope: {
          mode: "changed",
          base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
          changes: [{ status: "modified", path: "test/key.pem" }],
          affectedProjectIds: [],
          reasons: [],
          limitations: [],
        },
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      scope: "changed",
      filesExamined: 2,
      statementsRecognized: 0,
      limitations: [
        "test/key.pem: private key matched an inventoried localhost-only test certificate; no finding was emitted.",
      ],
    })]);
    expect(JSON.stringify(result)).not.toContain(fixture.privateKey.trim());
  });

  it("keeps non-local, unmatched, and certificate-less private keys as high findings", async () => {
    const local = createTestCertificate("localhost", "DNS:localhost");
    const nonLocal = createTestCertificate("service.example.invalid", "DNS:service.example.invalid");
    const otherLocal = createTestCertificate("localhost", "DNS:localhost,IP:127.0.0.1");
    const cases = [
      { key: nonLocal.privateKey, certificates: [nonLocal.certificate] },
      { key: local.privateKey, certificates: [otherLocal.certificate] },
      { key: local.privateKey, certificates: [] },
    ];

    for (const testCase of cases) {
      const files = [
        { path: "test/key.pem", kind: "file" as const, size: Buffer.byteLength(testCase.key) },
        ...testCase.certificates.map((certificate, index) => ({
          path: `test/certificate-${index}.pem`,
          kind: "file" as const,
          size: Buffer.byteLength(certificate),
        })),
      ];
      const contents = new Map<string, Buffer>([
        ["/repo/test/key.pem", Buffer.from(testCase.key)],
        ...testCase.certificates.map((certificate, index): [string, Buffer] => [
          `/repo/test/certificate-${index}.pem`,
          Buffer.from(certificate),
        ]),
      ]);
      const doctor = createSecretsDoctor({
        readFile: async (path) => contents.get(path) ?? Buffer.from(""),
      });
      const result = await doctor.diagnose({
        snapshot: snapshot({
          files,
          repositoryFiles: {
            availability: "available",
            paths: files.map(({ path }) => path),
            limitations: [],
          },
        }),
        allowedCapabilities: new Set(["filesystem:read"]),
      });

      expect(result.findings).toContainEqual(expect.objectContaining({
        ruleId: "security/secrets/private-key",
        severity: "high",
        location: expect.objectContaining({ path: "test/key.pem" }),
      }));
      expect(JSON.stringify(result)).not.toContain(testCase.key.trim());
    }
  });

  it("makes oversized selected files partial without reading them", async () => {
    const readFile = vi.fn(async () => Buffer.from("not read"));
    const doctor = createSecretsDoctor({ readFile, maxFileBytes: 10 });
    const result = await doctor.diagnose({
      snapshot: snapshot({
        files: [{ path: "large.txt", kind: "file", size: 11 }],
        repositoryFiles: {
          availability: "available",
          paths: ["large.txt"],
          limitations: [],
        },
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      filesExamined: 0,
      limitations: ["large.txt: file exceeds the 10-byte secrets audit size limit."],
    })]);
  });

  it("treats binary selected files as deliberately ineligible", async () => {
    const doctor = createSecretsDoctor({
      readFile: async () => Buffer.from([0x41, 0x00, 0x42]),
    });
    const result = await doctor.diagnose({
      snapshot: snapshot(),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "not-applicable",
      filesExamined: 0,
      statementsExamined: 0,
      limitations: [],
    })]);
  });

  it("turns read failures into path-only partial limitations", async () => {
    const seededError = token("failure-");
    const doctor = createSecretsDoctor({
      readFile: async () => { throw new Error(seededError); },
    });
    const result = await doctor.diagnose({
      snapshot: snapshot(),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      limitations: ["src/config.ts: unable to read selected file for secrets audit."],
    })]);
    expect(JSON.stringify(result)).not.toContain(seededError);
  });

  it("does not read symlinks admitted by source-control selection", async () => {
    const readFile = vi.fn(async () => Buffer.from("not read"));
    const doctor = createSecretsDoctor({ readFile });
    const result = await doctor.diagnose({
      snapshot: snapshot({
        files: [{ path: "linked.env", kind: "symlink", size: 8 }],
        repositoryFiles: {
          availability: "available",
          paths: ["linked.env"],
          limitations: [],
        },
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "not-applicable",
      filesExamined: 0,
    })]);
  });

  it("preserves an empty changed selection for domain-level not-selected mapping", async () => {
    const readFile = vi.fn(async () => Buffer.from("not read"));
    const doctor = createSecretsDoctor({ readFile });
    const result = await doctor.diagnose({
      snapshot: snapshot({
        auditScope: {
          mode: "changed",
          base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
          changes: [],
          affectedProjectIds: [],
          reasons: [],
          limitations: [],
        },
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "not-applicable",
      scope: "changed",
    })]);
  });

  it("stops before exceeding the total selected-content budget", async () => {
    const readFile = vi.fn(async () => Buffer.from("plain\n"));
    const doctor = createSecretsDoctor({ readFile, maxTotalBytes: 10 });
    const result = await doctor.diagnose({
      snapshot: snapshot({
        files: [
          { path: "a.txt", kind: "file", size: 6 },
          { path: "b.txt", kind: "file", size: 6 },
        ],
        repositoryFiles: {
          availability: "available",
          paths: ["a.txt", "b.txt"],
          limitations: [],
        },
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledWith("/repo/a.txt");
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      filesExamined: 1,
      limitations: [
        "b.txt: total secrets audit content limit of 10 bytes was reached; remaining selected files were not examined.",
      ],
    })]);
  });

  it("caps findings per file and marks the omitted matches partial", async () => {
    const secrets = [token("ghp_"), token("glpat-"), token("xoxb-")];
    const doctor = createSecretsDoctor({
      readFile: async () => Buffer.from(secrets.join("\n")),
      maxFindingsPerFile: 2,
    });
    const result = await doctor.diagnose({
      snapshot: snapshot(),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toHaveLength(2);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      statementsRecognized: 2,
      limitations: [
        "src/config.ts: secrets finding limit of 2 was reached; additional matches were withheld.",
      ],
    })]);
    for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("caps whole-audit findings and stops remaining output safely", async () => {
    const first = [token("ghp_"), token("glpat-")];
    const second = [token("xoxb-"), token("github_pat_")];
    const readFile = vi.fn(async (path: string) =>
      Buffer.from(path.endsWith("a.txt") ? first.join("\n") : second.join("\n"))
    );
    const doctor = createSecretsDoctor({
      readFile,
      maxFindings: 3,
      maxFindingsPerFile: 10,
    });
    const result = await doctor.diagnose({
      snapshot: snapshot({
        files: [
          { path: "a.txt", kind: "file", size: 100 },
          { path: "b.txt", kind: "file", size: 100 },
        ],
        repositoryFiles: {
          availability: "available",
          paths: ["a.txt", "b.txt"],
          limitations: [],
        },
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(result.findings).toHaveLength(3);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      statementsRecognized: 3,
      limitations: [
        "Secrets audit finding limit of 3 was reached; additional matches and remaining selected files were not reported.",
      ],
    })]);
    for (const secret of [...first, ...second]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("rejects invalid resource ceilings", () => {
    expect(() => createSecretsDoctor({ maxTotalBytes: 0 })).toThrow(/total.*positive/i);
    expect(() => createSecretsDoctor({ maxFindingsPerFile: 0 })).toThrow(/per-file.*positive/i);
    expect(() => createSecretsDoctor({ maxFindings: 0 })).toThrow(/finding.*positive/i);
  });
});
