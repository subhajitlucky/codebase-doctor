import type { LockEcosystem } from "./parser.js";

export interface OsvQuery {
  readonly ecosystem: LockEcosystem;
  readonly name: string;
  readonly version: string;
}

export interface OsvAdvisory {
  readonly id: string;
  readonly summary: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "unknown";
  readonly fixedIn?: string;
  readonly aliases: readonly string[];
}

export interface OsvPackageAdvisories {
  readonly package: OsvQuery;
  readonly advisories: readonly OsvAdvisory[];
}

export type OsvLookupResult =
  | {
      readonly status: "completed";
      readonly results: readonly OsvPackageAdvisories[];
      readonly limitations: readonly string[];
    }
  | { readonly status: "failed"; readonly message: string };

export interface OsvClient {
  lookup(packages: readonly OsvQuery[]): Promise<OsvLookupResult>;
}

export interface OsvClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBatchSize?: number;
  readonly maxDetailRequests?: number;
  readonly maxConcurrentDetails?: number;
}

const OSV_API = "https://api.osv.dev/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BATCH_SIZE = 500;
const DEFAULT_MAX_DETAIL_REQUESTS = 100;
const DEFAULT_MAX_CONCURRENT_DETAILS = 6;
const SUMMARY_LIMIT = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= SUMMARY_LIMIT ? flat : `${flat.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function severityFrom(value: unknown): OsvAdvisory["severity"] {
  if (typeof value !== "string") return "unknown";
  switch (value.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "unknown";
  }
}

function fixedVersionFrom(affected: unknown, query: OsvQuery): string | undefined {
  if (!Array.isArray(affected)) return undefined;
  const fixed: string[] = [];

  for (const entry of affected) {
    if (!isObject(entry) || !isObject(entry["package"])) continue;
    const pkg = entry["package"];
    if (pkg["name"] !== query.name) continue;
    if (!Array.isArray(entry["ranges"])) continue;

    for (const range of entry["ranges"]) {
      if (!isObject(range) || !Array.isArray(range["events"])) continue;
      for (const event of range["events"]) {
        if (isObject(event) && typeof event["fixed"] === "string" && event["fixed"].length > 0) {
          fixed.push(event["fixed"]);
        }
      }
    }
  }

  if (fixed.length === 0) return undefined;
  return fixed.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))[0];
}

function advisoryFrom(document: unknown, query: OsvQuery): OsvAdvisory | undefined {
  if (!isObject(document) || typeof document["id"] !== "string" || document["id"].length === 0) {
    return undefined;
  }
  const databaseSpecific = isObject(document["database_specific"])
    ? document["database_specific"]
    : undefined;
  const aliases = Array.isArray(document["aliases"])
    ? document["aliases"].filter((alias): alias is string => typeof alias === "string").slice(0, 5)
    : [];
  const fixedIn = fixedVersionFrom(document["affected"], query);

  return {
    id: document["id"],
    summary: boundedText(document["summary"], "No summary provided by the advisory source."),
    severity:
      severityFrom(databaseSpecific?.["severity"]) === "unknown"
        ? "medium"
        : severityFrom(databaseSpecific?.["severity"]),
    ...(fixedIn === undefined ? {} : { fixedIn }),
    aliases,
  };
}

/**
 * Minimal OSV client: one querybatch call plus bounded detail lookups. It
 * never sends repository content, only package names and versions, and it
 * never writes anything.
 */
export function createOsvClient(options: OsvClientOptions = {}): OsvClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const maxDetailRequests = options.maxDetailRequests ?? DEFAULT_MAX_DETAIL_REQUESTS;
  const maxConcurrentDetails = options.maxConcurrentDetails ?? DEFAULT_MAX_CONCURRENT_DETAILS;

  return {
    async lookup(packages: readonly OsvQuery[]): Promise<OsvLookupResult> {
      const limitations: string[] = [];
      const perPackage = new Map<string, OsvAdvisory[]>();
      const advisoryIds = new Map<string, Set<string>>();
      const identity = (query: OsvQuery): string =>
        `${query.ecosystem}:${query.name}@${query.version}`;
      const failed = (message: string): OsvLookupResult => ({ status: "failed", message });

      try {
        for (let start = 0; start < packages.length; start += maxBatchSize) {
          const chunk = packages.slice(start, start + maxBatchSize);
          const response = await fetchImpl(`${OSV_API}/querybatch`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              queries: chunk.map((query) => ({
                package: { name: query.name, ecosystem: query.ecosystem },
                version: query.version,
              })),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            return failed(`OSV querybatch returned HTTP ${response.status}.`);
          }

          const body: unknown = await response.json();
          const results = isObject(body) && Array.isArray(body["results"]) ? body["results"] : [];
          for (let index = 0; index < chunk.length; index += 1) {
            const query = chunk[index]!;
            const entry = results[index];
            const vulns = isObject(entry) && Array.isArray(entry["vulns"]) ? entry["vulns"] : [];
            const ids = advisoryIds.get(identity(query)) ?? new Set<string>();
            for (const vuln of vulns) {
              if (isObject(vuln) && typeof vuln["id"] === "string" && vuln["id"].length > 0) {
                ids.add(vuln["id"]);
              }
            }
            advisoryIds.set(identity(query), ids);
            perPackage.set(identity(query), perPackage.get(identity(query)) ?? []);
          }
        }
      } catch (error) {
        return failed(
          `OSV advisory lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const uniqueIds = [...new Set([...advisoryIds.values()].flatMap((ids) => [...ids]))].sort();
      const detailIds = uniqueIds.slice(0, maxDetailRequests);
      if (uniqueIds.length > maxDetailRequests) {
        limitations.push(
          `Advisory detail limit of ${maxDetailRequests} was reached; ${uniqueIds.length - maxDetailRequests} advisor${uniqueIds.length - maxDetailRequests === 1 ? "y was" : "ies were"} not expanded.`,
        );
      }

      const details = new Map<string, OsvAdvisory>();
      for (let start = 0; start < detailIds.length; start += maxConcurrentDetails) {
        const chunk = detailIds.slice(start, start + maxConcurrentDetails);
        const fetched = await Promise.all(
          chunk.map(async (id) => {
            try {
              const response = await fetchImpl(`${OSV_API}/vulns/${encodeURIComponent(id)}`, {
                signal: AbortSignal.timeout(timeoutMs),
              });
              if (!response.ok) return { id, status: `HTTP ${response.status}` } as const;
              return { id, document: (await response.json()) as unknown } as const;
            } catch (error) {
              return {
                id,
                status: error instanceof Error ? error.message : String(error),
              } as const;
            }
          }),
        );

        for (const result of fetched) {
          if ("document" in result) {
            const query = packages.find((candidate) =>
              [...(advisoryIds.get(identity(candidate)) ?? [])].includes(result.id),
            );
            if (query === undefined) continue;
            const advisory = advisoryFrom(result.document, query);
            if (advisory !== undefined) details.set(result.id, advisory);
          } else {
            limitations.push(`Advisory ${result.id} details could not be fetched (${result.status}).`);
          }
        }
      }

      const results: OsvPackageAdvisories[] = packages.map((query) => ({
        package: query,
        advisories: [...(advisoryIds.get(identity(query)) ?? [])]
          .map((id) => details.get(id))
          .filter((advisory): advisory is OsvAdvisory => advisory !== undefined)
          .sort((left, right) => left.id.localeCompare(right.id)),
      }));

      return { status: "completed", results, limitations };
    },
  };
}
