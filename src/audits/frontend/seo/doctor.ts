import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";
import { isHtmlPath } from "../accessibility/doctor.js";

const DOCTOR_ID = "frontend/seo";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 20_000_000;
const DEFAULT_MAX_FINDINGS = 200;

export interface SeoDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFindings?: number;
}

export interface SeoAnalysis {
  readonly documentsExamined: number;
  readonly findings: readonly Finding[];
  readonly limitations: readonly string[];
}

function findingFor(
  ruleId: string,
  severity: Finding["severity"],
  path: string,
  title: string,
  message: string,
  detail: string,
  identity: string,
  impact: string,
  remediation: string,
  changed: boolean,
): Finding {
  const location = { path };
  return {
    ruleId: `${DOCTOR_ID}/${ruleId}`,
    doctorId: DOCTOR_ID,
    severity,
    confidence: "high",
    category: "frontend",
    title,
    message,
    location,
    evidence: [{ type: "file", path, detail }],
    impact,
    remediationConstraints: [
      "Keep the document valid HTML for the site's rendering pipeline.",
      "Templates or framework metadata may replace static document tags; update the source of truth.",
    ],
    remediation,
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --format json"
        : "codebase-doctor audit . --format json",
      expected: "The finding fingerprint is absent and frontend/seo coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${ruleId}`,
      location,
      identity,
    }),
  };
}

/**
 * Deterministic, offline SEO checks for static HTML documents: a non-empty
 * title element and a non-empty meta description. Framework-generated
 * documents are out of scope because their metadata lives in application code.
 */
export function analyzeHtmlSeo(path: string, content: string, changed: boolean): SeoAnalysis {
  const source = content.replace(/<!--[\s\S]*?-->/gu, "");
  const findings: Finding[] = [];

  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(source);
  if (title === null || (title[1] ?? "").trim().length === 0) {
    findings.push(findingFor(
      "missing-title",
      "medium",
      path,
      "Document has no non-empty title element",
      "The HTML document has no title element with text content.",
      "missing or empty title element",
      "missing-title",
      "Search results and browser tabs cannot present a meaningful page title.",
      "Add a unique, descriptive title element inside the document head.",
      changed,
    ));
  }

  const description = /<meta\b[^>]*\bname\s*=\s*["']?description["']?[^>]*>/iu.exec(source);
  const content2 = description === null
    ? undefined
    : /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(description[0]);
  const descriptionText = content2?.[1] ?? content2?.[2] ?? "";
  if (description === null || descriptionText.trim().length === 0) {
    findings.push(findingFor(
      "missing-meta-description",
      "low",
      path,
      "Document has no meta description",
      "The HTML document has no non-empty meta description tag.",
      "missing or empty meta description",
      "missing-meta-description",
      "Search engines may generate a less accurate snippet for this page.",
      "Add a concise meta description that summarizes the page.",
      changed,
    ));
  }

  return { documentsExamined: 1, findings: sortFindings(findings), limitations: [] };
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  documentsExamined: number,
  findingsReported: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: documentsExamined,
    statementsRecognized: findingsReported,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function createSeoDoctor(options: SeoDoctorOptions = {}): Doctor {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const readSelectedFile = options.readFile ?? readFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const candidates = snapshot.files
        .filter((file) => file.kind === "file" && isHtmlPath(file.path))
        .map((file) => file.path)
        .sort();
      if (candidates.length === 0) {
        return {
          status: "completed",
          findings: [],
          coverage: [coverage("not-applicable", snapshot.auditScope.mode, 0, 0, 0, [])],
          durationMs: Date.now() - startedAt,
        };
      }

      const limitations: string[] = [];
      const findings: Finding[] = [];
      let filesExamined = 0;
      let totalBytes = 0;
      for (const path of candidates) {
        if (findings.length >= maxFindings) {
          limitations.push(`SEO audit finding limit of ${maxFindings} was reached; remaining documents were not reported.`);
          break;
        }
        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte SEO audit size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.push(`SEO audit total content limit of ${maxTotalBytes} bytes was reached; remaining documents were not examined.`);
          break;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readSelectedFile(join(snapshot.root, ...path.split("/")));
        } catch {
          limitations.push(`${path}: document could not be read.`);
          continue;
        }
        totalBytes += bytes.byteLength;
        filesExamined += 1;
        const analysis = analyzeHtmlSeo(path, Buffer.from(bytes).toString("utf8"), snapshot.auditScope.mode === "changed");
        findings.push(...analysis.findings);
      }

      return {
        status: "completed",
        findings: sortFindings(findings).slice(0, maxFindings),
        coverage: [coverage(
          limitations.length > 0 ? "partial" : "completed",
          snapshot.auditScope.mode,
          filesExamined,
          filesExamined,
          Math.min(findings.length, maxFindings),
          limitations,
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
