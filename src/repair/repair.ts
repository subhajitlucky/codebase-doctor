import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Finding } from "../core/findings.js";

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const MAX_CANDIDATES = 200;

export interface ImportRepairPlan {
  ruleId: string;
  fingerprint: string;
  file: string;
  originalSpecifier: string;
  replacementSpecifier: string;
  candidatePath: string;
  patchedContent: string;
}

export class RepairError extends Error {}

function stemOf(fileName: string): string {
  return basename(fileName, extname(fileName));
}

async function walkSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < MAX_CANDIDATES * 20) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (SUPPORTED_EXTENSIONS.includes(extname(entry.name))) {
        files.push(path);
      }
    }
  }
  return files;
}

function specifierFor(originalSpecifier: string, candidatePath: string, importerPath: string): string {
  const relativePath = relative(dirname(importerPath), candidatePath).split(sep).join("/");
  const withPrefix = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  const candidateExtension = extname(candidatePath);
  const originalExtension = extname(originalSpecifier);
  if (originalExtension === ".js" && (candidateExtension === ".ts" || candidateExtension === ".tsx")) {
    return withPrefix.slice(0, -candidateExtension.length) + ".js";
  }
  if (originalExtension === ".jsx" && candidateExtension === ".tsx") {
    return withPrefix.slice(0, -candidateExtension.length) + ".jsx";
  }
  return withPrefix;
}

async function brokenSpecifiers(filePath: string, fileContent: string): Promise<string[]> {
  const specifiers: string[] = [];
  const patterns = [
    /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/gu,
    /require\s*\(\s*["'](\.[^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of fileContent.matchAll(pattern)) {
      const specifier = match[1]!;
      if (!specifiers.includes(specifier)) specifiers.push(specifier);
    }
  }
  return specifiers.filter((specifier) => {
    const resolved = resolve(dirname(filePath), specifier);
    if (existsSync(resolved)) return false;
    const stem = resolved.slice(0, resolved.length - extname(resolved).length);
    return !SUPPORTED_EXTENSIONS.some((extension) => existsSync(`${stem}${extension}`));
  });
}

/**
 * Plan a repair for a missing import target: find an unambiguous existing
 * candidate by stem (exact match first, then prefix match), preferring the
 * importer's own directory. Returns undefined when the repair is ambiguous
 * or the candidate does not exist — never guesses.
 */
export async function planImportRepair(
  root: string,
  finding: Finding,
): Promise<ImportRepairPlan | undefined> {
  if (finding.ruleId !== "source/import-target-missing" || finding.location === undefined) {
    return undefined;
  }
  const importerPath = resolve(root, finding.location.path);
  const fileContent = await readFile(importerPath, "utf8");
  const broken = await brokenSpecifiers(importerPath, fileContent);
  if (broken.length !== 1) return undefined;
  const originalSpecifier = broken[0]!;
  const missingStem = stemOf(originalSpecifier);

  const files = await walkSourceFiles(root);
  const importerDirectory = dirname(importerPath);
  const rank = (candidate: string): number => {
    const stem = stemOf(candidate);
    const inDirectory = dirname(candidate) === importerDirectory ? 0 : 1;
    const exact = stem === missingStem ? 0 : 1;
    const prefix = stem.startsWith(missingStem) || missingStem.startsWith(stem) ? 0 : 1;
    return inDirectory * 100 + exact * 10 + prefix;
  };
  const matches = files
    .filter((candidate) => {
      const stem = stemOf(candidate);
      return stem === missingStem || stem.startsWith(missingStem) || missingStem.startsWith(stem);
    })
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));

  if (matches.length === 0) return undefined;
  const best = matches[0]!;
  if (matches.length > 1 && rank(matches[1]!) === rank(best)) return undefined;

  const replacementSpecifier = specifierFor(originalSpecifier, best, importerPath);
  const patchedContent = fileContent.replace(
    new RegExp(`(["'])${originalSpecifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\1`, "u"),
    `"${replacementSpecifier}"`,
  );
  if (patchedContent === fileContent) return undefined;

  return {
    ruleId: finding.ruleId,
    fingerprint: finding.fingerprint,
    file: finding.location.path,
    originalSpecifier,
    replacementSpecifier,
    candidatePath: relative(root, best).split(sep).join("/"),
    patchedContent,
  };
}
