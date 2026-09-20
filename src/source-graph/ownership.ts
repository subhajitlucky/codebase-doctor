import type { DetectedProject } from "../workspace/types.js";

export function ownerProjectOf(
  path: string,
  projects: readonly DetectedProject[],
): DetectedProject | undefined {
  return [...projects]
    .filter((project) =>
      project.root === "." ||
      path === project.root ||
      path.startsWith(`${project.root}/`)
    )
    .sort((left, right) =>
      (right.root === "." ? 0 : right.root.split("/").length) -
        (left.root === "." ? 0 : left.root.split("/").length) ||
      left.id.localeCompare(right.id)
    )[0];
}
