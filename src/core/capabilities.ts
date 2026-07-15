export type Capability =
  | "filesystem:read"
  | "process:execute"
  | "network:access"
  | "filesystem:write";

export interface CapabilityOptions {
  runChecks: boolean;
}

export function buildAllowedCapabilities(
  options: CapabilityOptions,
): ReadonlySet<Capability> {
  const capabilities = new Set<Capability>(["filesystem:read"]);
  if (options.runChecks) capabilities.add("process:execute");
  return capabilities;
}
