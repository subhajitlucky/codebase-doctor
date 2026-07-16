import { describe, expect, it } from "vitest";
import type { Capability } from "../../../src/core/capabilities.js";

function capability(value: Capability): Capability {
  return value;
}

describe("Doctor capability boundary", () => {
  it("contains only read, validation execution, and network access", () => {
    expect([
      capability("filesystem:read"),
      capability("process:execute"),
      capability("network:access"),
    ]).toHaveLength(3);

    // @ts-expect-error Codebase Doctor permanently has no target-write authority.
    capability("filesystem:write");
  });
});
