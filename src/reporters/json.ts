import type { ScanResult } from "../core/normalize.js";

export function renderJsonReport(result: ScanResult): string {
  const serialized = JSON.stringify(result, null, 2);
  return `${serialized}\n`;
}
