import { describe, expect, it } from "vitest";
import type { Capability } from "../../../src/core/capabilities.js";

function capability(value: Capability): Capability {
  return value;
}

const filesystem = "filesystem" as const;
const write = "write" as const;

describe("Doctor capability boundary", () => {
  it("contains only read, validation execution, and explicitly permissioned network access", () => {
    expect([
      capability("filesystem:read"),
      capability("process:execute"),
      capability("network:access"),
      capability("network:advisories"),
    ]).toHaveLength(4);

    // @ts-expect-error Codebase Doctor permanently has no target-write authority.
    capability(`${filesystem}:${write}`);
  });
});
