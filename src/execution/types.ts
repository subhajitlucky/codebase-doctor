export interface CommandPlan {
  id: string;
  projectId: string;
  label: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export type CommandRunResult =
  | (CommandOutput & {
      status: "completed";
      exitCode: number;
      signal: NodeJS.Signals | null;
    })
  | (CommandOutput & {
      status: "timed-out";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    })
  | (CommandOutput & {
      status: "failed-to-start";
      error: string;
    });

export interface CommandRunnerOptions {
  sourceEnvironment?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  plan: CommandPlan,
  options?: CommandRunnerOptions,
) => Promise<CommandRunResult>;
