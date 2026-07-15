import { afterEach, describe, expect, it } from "vitest";
import {
  CodebaseConfigError,
  loadCodebaseConfig,
  validateExcludePattern,
} from "../../../src/config/config.js";
import {
  createTempProject,
  removeTempProject,
  writeProjectFile,
} from "../../helpers/temp-project.js";

const temporaryRoots: string[] = [];

async function project(): Promise<string> {
  const root = await createTempProject();
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTempProject));
});

describe("Codebase Doctor configuration", () => {
  it("uses an empty configuration when the file is absent", async () => {
    await expect(loadCodebaseConfig(await project())).resolves.toEqual({ exclude: [] });
  });

  it("loads validated exclusion patterns", async () => {
    const root = await project();
    await writeProjectFile(root, ".codebase-doctor.json", JSON.stringify({
      exclude: ["test/fixtures/**", "examples/*.json"],
    }));

    await expect(loadCodebaseConfig(root)).resolves.toEqual({
      exclude: ["test/fixtures/**", "examples/*.json"],
    });
  });

  it.each([
    ["{", /valid JSON/i],
    [JSON.stringify({ ignored: [] }), /unknown configuration key/i],
    [JSON.stringify({ exclude: "dist" }), /array of strings/i],
    [JSON.stringify({ exclude: [1] }), /array of strings/i],
    [JSON.stringify({ exclude: ["/tmp/**"] }), /relative/i],
    [JSON.stringify({ exclude: ["../outside/**"] }), /must not escape/i],
  ])("rejects an invalid configuration: %s", async (contents, message) => {
    const root = await project();
    await writeProjectFile(root, ".codebase-doctor.json", contents);

    await expect(loadCodebaseConfig(root)).rejects.toEqual(expect.objectContaining({
      name: "CodebaseConfigError",
      message: expect.stringMatching(message),
    }));
    await expect(loadCodebaseConfig(root)).rejects.toThrow(/\.codebase-doctor\.json/);
  });

  it("normalizes repository-relative patterns", () => {
    expect(validateExcludePattern("./test\\fixtures/**")).toBe("test/fixtures/**");
    expect(() => validateExcludePattern("")).toThrow(CodebaseConfigError);
  });
});
