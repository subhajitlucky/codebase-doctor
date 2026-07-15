export interface FileRecord {
  path: string;
  kind: "file" | "symlink";
  size: number;
}

export interface FileInventory {
  root: string;
  files: readonly FileRecord[];
}

export interface FileInventoryOptions {
  maxFiles?: number;
  maxDepth?: number;
}
