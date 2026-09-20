import type { SourceImportKind } from "./types.js";

export interface SafeImportReference {
  readonly kind: SourceImportKind;
  readonly line?: number;
  readonly column?: number;
}

const rawSpecifiers = new WeakMap<SafeImportReference, string>();
const sourceOffsets = new WeakMap<SafeImportReference, number>();

export function createImportReference(
  kind: SourceImportKind,
  specifier: string,
  location: { readonly line?: number; readonly column?: number },
  sourceOffset = Number.MAX_SAFE_INTEGER,
): SafeImportReference {
  const reference: SafeImportReference = { kind, ...location };
  rawSpecifiers.set(reference, specifier);
  sourceOffsets.set(reference, sourceOffset);
  return reference;
}

export function importSpecifier(reference: SafeImportReference): string | undefined {
  return rawSpecifiers.get(reference);
}

export function importSourceOffset(reference: SafeImportReference): number {
  return sourceOffsets.get(reference) ?? Number.MAX_SAFE_INTEGER;
}
