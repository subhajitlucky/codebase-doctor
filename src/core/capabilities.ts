export type Capability =
  | "filesystem:read"
  | "process:execute"
  | "network:access";

export interface CapabilityOptions {
  runChecks: boolean;
  withDatabase?: boolean;
}

export function buildAllowedCapabilities(
  options: CapabilityOptions,
): ReadonlySet<Capability> {
  const capabilities = new Set<Capability>(["filesystem:read"]);
  if (options.runChecks) capabilities.add("process:execute");
  if (options.withDatabase === true) capabilities.add("network:access");
  return capabilities;
}
