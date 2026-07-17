import { describe, expect, expectTypeOf, it } from "vitest";
import {
  discoverRepositoryFiles,
  parseRepositoryFiles,
  type RepositoryFileSelection,
} from "../../../src/scope/repository-files.js";

describe("repository-shareable file parsing", () => {
  it("returns normalized, deduplicated paths in deterministic order", () => {
    expect(parseRepositoryFiles([
      "zeta.ts",
      "nested/file.ts",
      "alpha file.ts",
      "nested/file.ts",
    ].join("\0") + "\0")).toEqual([
      "alpha file.ts",
      "nested/file.ts",
      "zeta.ts",
    ]);
  });

  it.each([
    ["unterminated", "file.ts"],
    ["empty", "\0"],
    ["absolute", "/outside.ts\0"],
    ["Windows absolute", "C:\\outside.ts\0"],
    ["drive relative", "C:outside.ts\0"],
    ["parent escaping", "../outside.ts\0"],
    ["embedded parent segment", "nested/../outside.ts\0"],
  ])("rejects %s Git paths", (_label, output) => {
    expect(() => parseRepositoryFiles(output)).toThrow(/path|NUL|terminated/i);
  });

  it("accepts an empty Git file list", () => {
    expect(parseRepositoryFiles("")).toEqual([]);
  });
});

describe("repository-shareable file discovery", () => {
  it("uses only fixed read-only Git commands", async () => {
    const root = process.cwd();
    const calls: string[][] = [];
    const runner = {
      run: async (_root: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === "rev-parse") return `${root}\n`;
        return "tracked.env\0untracked.ts\0";
      },
    };

    const selection = await discoverRepositoryFiles(root, runner);

    expect(selection).toEqual({
      availability: "available",
      paths: ["tracked.env", "untracked.ts"],
      limitations: [],
    });
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    ]);
  });

  it("returns one safe unavailable limitation for runner failures", async () => {
    const seededSecret = "https://user:super-secret@example.invalid/repo.git";
    const selection: RepositoryFileSelection = await discoverRepositoryFiles(
      process.cwd(),
      { run: async () => { throw new Error(seededSecret); } },
    );

    expect(selection).toEqual({
      availability: "unavailable",
      paths: [],
      limitations: [
        "Git shareable-file selection was unavailable; conservative local-environment fallback rules were used.",
      ],
    });
    expect(JSON.stringify(selection)).not.toContain(seededSecret);
  });

  it("uses the same safe result for mismatched roots and invalid output", async () => {
    const mismatched = await discoverRepositoryFiles(process.cwd(), {
      run: async (_root, args) => args[0] === "rev-parse" ? "/tmp\n" : "",
    });
    const invalid = await discoverRepositoryFiles(process.cwd(), {
      run: async (_root, args) => args[0] === "rev-parse"
        ? `${process.cwd()}\n`
        : "unterminated",
    });

    expect(mismatched.availability).toBe("unavailable");
    expect(invalid.availability).toBe("unavailable");
    expect(mismatched.limitations).toEqual(invalid.limitations);
  });

  it("exposes a readonly selection contract", () => {
    expectTypeOf<RepositoryFileSelection>().toEqualTypeOf<{
      readonly availability: "available" | "unavailable";
      readonly paths: readonly string[];
      readonly limitations: readonly string[];
    }>();
  });
});
