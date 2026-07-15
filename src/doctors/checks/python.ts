import { join, posix } from "node:path";
import { createCommandPlan } from "../../execution/command-plan.js";
import type { CommandPlan } from "../../execution/types.js";
import type { DetectedProject, ProjectSnapshot } from "../../workspace/types.js";

type PythonTool = "pytest" | "ruff" | "mypy";

function pathAtRoot(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

function isWithinRoot(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function belongsToProject(
  path: string,
  project: DetectedProject,
  pythonProjects: readonly DetectedProject[],
): boolean {
  if (!isWithinRoot(path, project.root)) return false;
  return !pythonProjects.some((candidate) =>
    candidate.id !== project.id &&
    candidate.root !== "." &&
    isWithinRoot(candidate.root, project.root) &&
    isWithinRoot(path, candidate.root),
  );
}

function pytestEvidence(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const name = posix.basename(path);
    return name === "pytest.ini" || name === "tox.ini" || name === "conftest.py" ||
      /^test_.+\.py$/.test(name) ||
      path.split("/").some((segment) => segment === "test" || segment === "tests");
  });
}

function configuredTools(paths: readonly string[]): PythonTool[] {
  const names = new Set(paths.map((path) => posix.basename(path)));
  const tools: PythonTool[] = [];
  if (pytestEvidence(paths)) tools.push("pytest");
  if (names.has("ruff.toml") || names.has(".ruff.toml")) tools.push("ruff");
  if (names.has("mypy.ini") || names.has(".mypy.ini")) tools.push("mypy");
  return tools;
}

function commandFor(tool: PythonTool, runner: "uv" | "poetry" | undefined): {
  executable: string;
  args: readonly string[];
} {
  const toolArgs = tool === "pytest"
    ? ["pytest"]
    : tool === "ruff" ? ["ruff", "check", "."] : ["mypy", "."];
  if (runner !== undefined) return { executable: runner, args: ["run", ...toolArgs] };
  if (tool === "pytest") return { executable: "python", args: ["-m", "pytest"] };
  return { executable: tool, args: toolArgs.slice(1) };
}

export function planPythonChecks(
  snapshot: ProjectSnapshot,
  timeoutMs: number,
): CommandPlan[] {
  const pythonProjects = snapshot.projects.filter(({ ecosystems }) => ecosystems.includes("python"));
  const filePaths = snapshot.files.filter(({ kind }) => kind === "file").map(({ path }) => path);
  const plans: CommandPlan[] = [];

  for (const project of pythonProjects) {
    const projectPaths = filePaths.filter((path) => belongsToProject(path, project, pythonProjects));
    const runner = projectPaths.includes(pathAtRoot(project.root, "uv.lock"))
      ? "uv" as const
      : projectPaths.includes(pathAtRoot(project.root, "poetry.lock")) ? "poetry" as const : undefined;
    const cwd = project.root === "."
      ? snapshot.root
      : join(snapshot.root, ...project.root.split("/"));

    for (const tool of configuredTools(projectPaths)) {
      const command = commandFor(tool, runner);
      plans.push(createCommandPlan({
        id: `${project.id}:python:${tool}`,
        projectId: project.id,
        label: `Python ${tool}`,
        executable: command.executable,
        args: command.args,
        cwd,
        timeoutMs,
      }));
    }
  }

  return plans;
}
