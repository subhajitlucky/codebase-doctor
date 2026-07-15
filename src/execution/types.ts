export interface CommandPlan {
  id: string;
  projectId: string;
  label: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}
