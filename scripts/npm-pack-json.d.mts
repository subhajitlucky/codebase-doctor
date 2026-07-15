export interface NpmPackFile {
  path: string;
}

export interface NpmPackReport {
  id: string;
  name: string;
  version: string;
  filename: string;
  size: number;
  files: NpmPackFile[];
}

export function parseNpmPackJson(output: string): NpmPackReport[];
