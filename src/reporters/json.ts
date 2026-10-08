import type { ScanResult } from "../core/normalize.js";
import { scoreScanResult } from "../core/score.js";

export function renderJsonReport(result: ScanResult): string {
  const serialized = JSON.stringify({ ...result, score: scoreScanResult(result) }, null, 2);
  return `${serialized}\n`;
}
