import type { ScanResult } from "../core/normalize.js";
import { scoreScanResult } from "../core/score.js";

export const REPO_HEALTH_LABEL = "Repo Health";

export interface ScoreRenderOptions {
  score?: boolean;
  badge?: boolean;
}

export function renderScoreLine(result: ScanResult): string {
  return `${REPO_HEALTH_LABEL}: ${scoreScanResult(result).value}/100\n`;
}

export function scoreBadgeUrl(result: ScanResult): string {
  const score = scoreScanResult(result);
  const label = encodeURIComponent(REPO_HEALTH_LABEL);
  return `https://img.shields.io/badge/${label}-${score.value}%2F100-${score.band}`;
}

/**
 * `--score` prints the health score, `--badge` prints a shields.io badge URL.
 * Both derive from the same deterministic report score; neither replaces the
 * full report's evidence.
 */
export function renderScoreOutput(
  result: ScanResult,
  options: ScoreRenderOptions,
): string | undefined {
  const lines: string[] = [];
  if (options.score === true) lines.push(renderScoreLine(result).trimEnd());
  if (options.badge === true) lines.push(scoreBadgeUrl(result));
  return lines.length === 0 ? undefined : `${lines.join("\n")}\n`;
}
