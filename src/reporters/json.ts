import type { ScanResult } from "../core/normalize.js";

export function renderJsonReport(result: ScanResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
