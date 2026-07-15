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
  exclude?: readonly string[];
}

export type JsonObject = Record<string, unknown>;

export type ManifestRecord =
  | {
      kind: "package-json";
      path: string;
      status: "valid";
      data: JsonObject;
    }
  | {
      kind: "package-json";
      path: string;
      status: "invalid";
      error: string;
    };

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface DetectedProject {
  id: string;
  root: string;
  ecosystems: readonly string[];
  languages: readonly string[];
  frameworks: readonly string[];
  packageManager?: PackageManager;
  manifestPaths: readonly string[];
  executionSupport: "supported" | "detected-only";
}

export interface WorkspaceRecord {
  ownerProjectId: string;
  sourcePath: string;
  pattern: string;
  supported: boolean;
  matchedProjectRoots: readonly string[];
}

export interface ProjectDetection {
  projects: readonly DetectedProject[];
  workspaces: readonly WorkspaceRecord[];
}

export interface ProjectSnapshot {
  root: string;
  files: readonly FileRecord[];
  manifests: readonly ManifestRecord[];
  projects: readonly DetectedProject[];
  workspaces: readonly WorkspaceRecord[];
}
