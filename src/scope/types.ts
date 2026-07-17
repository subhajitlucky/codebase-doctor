export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked';

export interface ChangedPath {
  readonly status: ChangeStatus;
  readonly path: string;
  readonly previousPath?: string;
}

export interface AuditBase {
  readonly kind: 'head' | 'merge-base';
  readonly requestedRef: string | null;
  readonly resolvedCommit: string;
}

export interface ScopeReason {
  readonly projectId: string;
  readonly reason:
    | 'direct-change'
    | 'workspace-dependent'
    | 'root-context'
    | 'source-dependent';
  readonly source: string;
}

export interface AuditScope {
  readonly mode: 'full' | 'changed';
  readonly base: AuditBase | null;
  readonly changes: readonly ChangedPath[];
  readonly affectedProjectIds: readonly string[];
  readonly reasons: readonly ScopeReason[];
  readonly limitations: readonly string[];
}
