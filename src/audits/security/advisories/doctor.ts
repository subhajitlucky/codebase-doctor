import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { sortFindings, type Finding } from "../../../core/findings.js";
import { advisoryFindings } from "./analyzer.js";
import { createOsvClient, type OsvClient, type OsvPackageAdvisories, type OsvQuery } from "./osv.js";
import { lockfileFormatForPath, scanLockfile } from "./parser.js";

const DOCTOR_ID = "security/advisories";
const DEFAULT_MAX_FILE_BYTES = 20_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 100_000_000;
const DEFAULT_MAX_PACKAGES = 1_000;

const POINT_IN_TIME_NOTE =
  "Advisory data is point-in-time from api.osv.dev and can change as new advisories are published.";

export interface AdvisoriesDoctorOptions {
  readonly client?: OsvClient;
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxPackages?: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  packagesQueried: number,
  findingsReported: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: packagesQueried,
    statementsRecognized: findingsReported,
    limitations: [...new Set(limitations)].sort(),
  };
}

/**
 * Opt-in advisory lookup across every discovered supported lockfile
 * (package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, poetry.lock,
 * uv.lock). The module is only registered when the caller explicitly requests
 * it (--with-advisories), which also grants the network:advisories capability;
 * without that request no advisory module appears in reports, so an
 * unrequested lookup never marks the security domain incomplete. Only package
 * names, versions, and ecosystems leave the machine.
 */
export function createAdvisoriesDoctor(options: AdvisoriesDoctorOptions = {}): Doctor {
  const maxFileBytes = positiveInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    "Advisory audit file size limit",
  );
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    "Advisory audit total content limit",
  );
  const maxPackages = positiveInteger(
    options.maxPackages,
    DEFAULT_MAX_PACKAGES,
    "Advisory audit package limit",
  );
  const readSelectedFile = options.readFile ?? readFile;
  const client = options.client ?? createOsvClient();

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read", "network:advisories"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const limitations = new Set<string>();
      const lockPaths = snapshot.files
        .filter((file) => file.kind === "file" && lockfileFormatForPath(file.path) !== undefined)
        .map((file) => file.path)
        .sort();

      if (lockPaths.length === 0) {
        return {
          status: "completed",
          findings: [],
          coverage: [coverage("not-applicable", snapshot.auditScope.mode, 0, 0, 0, [])],
          durationMs: Date.now() - startedAt,
        };
      }

      const targets: Array<{ lockPath: string; packages: OsvQuery[] }> = [];
      const seenPackages = new Set<string>();
      let totalBytes = 0;
      let filesExamined = 0;
      let limitReached = false;

      for (const path of lockPaths) {
        if (limitReached) break;

        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.add(`${path}: file exceeds the ${maxFileBytes}-byte advisory audit size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.add(
            `${path}: total advisory audit content limit of ${maxTotalBytes} bytes was reached; remaining lockfiles were not examined.`,
          );
          break;
        }

        let bytes: Uint8Array | undefined;
        try {
          bytes = await readSelectedFile(join(snapshot.root, ...path.split("/")));
        } catch {
          limitations.add(`${path}: unable to read selected dependency metadata.`);
          continue;
        }
        if (bytes.byteLength > maxFileBytes) {
          limitations.add(`${path}: file exceeds the ${maxFileBytes}-byte advisory audit size limit.`);
          continue;
        }
        if (totalBytes + bytes.byteLength > maxTotalBytes) {
          limitations.add(
            `${path}: total advisory audit content limit of ${maxTotalBytes} bytes was reached; remaining lockfiles were not examined.`,
          );
          break;
        }

        totalBytes += bytes.byteLength;
        filesExamined += 1;

        const scanned = scanLockfile(path, Buffer.from(bytes).toString("utf8"));
        if (scanned.status !== "supported") {
          limitations.add(`${path}: ${scanned.reason ?? "dependency metadata is not supported"}.`);
          continue;
        }

        const packages: OsvQuery[] = [];
        for (const entry of scanned.packages) {
          const identity = `${entry.ecosystem}:${entry.name}@${entry.version}`;
          if (seenPackages.has(identity)) continue;
          if (seenPackages.size >= maxPackages) {
            limitations.add(
              `Advisory audit package limit of ${maxPackages} was reached; remaining resolved packages were not queried.`,
            );
            limitReached = true;
            break;
          }
          seenPackages.add(identity);
          packages.push({ ecosystem: entry.ecosystem, name: entry.name, version: entry.version });
        }

        if (packages.length > 0) targets.push({ lockPath: path, packages });
      }

      const allPackages = targets.flatMap((target) => target.packages);
      const findings: Finding[] = [];
      const lookupLimitations: string[] = [];
      let findingsReported = 0;

      if (allPackages.length > 0) {
        const lookup = await client.lookup(allPackages);
        if (lookup.status === "failed") {
          limitations.add(
            `Advisory lookup did not complete: ${lookup.message} Advisory coverage is incomplete, and zero findings is not a clean result.`,
          );
        } else {
          lookupLimitations.push(...lookup.limitations);
          const byIdentity = new Map<string, OsvPackageAdvisories>(
            lookup.results.map((result) => [
              `${result.package.ecosystem}:${result.package.name}@${result.package.version}`,
              result,
            ]),
          );

          for (const target of targets) {
            const advisories = target.packages
              .map((pkg) => byIdentity.get(`${pkg.ecosystem}:${pkg.name}@${pkg.version}`))
              .filter((entry): entry is OsvPackageAdvisories => entry !== undefined);
            const targetFindings = advisoryFindings({
              lockPath: target.lockPath,
              advisories,
              changed: snapshot.auditScope.mode === "changed",
            });
            findingsReported += targetFindings.length;
            findings.push(...targetFindings);
          }
        }
      }

      return {
        status: "completed",
        findings: sortFindings(findings),
        coverage: [
          coverage(
            limitations.size > 0 || lookupLimitations.length > 0 ? "partial" : "completed",
            snapshot.auditScope.mode,
            filesExamined,
            allPackages.length,
            findingsReported,
            [...limitations, ...lookupLimitations, POINT_IN_TIME_NOTE],
          ),
        ],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
