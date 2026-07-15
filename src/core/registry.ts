import { buildAllowedCapabilities, type CapabilityOptions } from "./capabilities.js";
import type {
  Doctor,
  DoctorContext,
  DoctorResult,
  RegisteredDoctorResult,
} from "./doctor.js";
import type { ProjectSnapshot } from "../workspace/types.js";

function skipped(skipReason: string): DoctorResult {
  return { status: "skipped", findings: [], skipReason, durationMs: 0 };
}

function failure(error: unknown, startedAt: number): DoctorResult {
  return {
    status: "failed",
    findings: [],
    error: {
      code: "doctor_execution_failed",
      message: error instanceof Error ? error.message : String(error),
    },
    durationMs: Date.now() - startedAt,
  };
}

export async function runDoctors(
  doctors: readonly Doctor[],
  snapshot: ProjectSnapshot,
  options: CapabilityOptions,
): Promise<RegisteredDoctorResult[]> {
  const allowedCapabilities = buildAllowedCapabilities(options);
  const context: DoctorContext = { snapshot, allowedCapabilities };
  const results: RegisteredDoctorResult[] = [];

  for (const doctor of doctors) {
    const denied = doctor.capabilities.filter((capability) =>
      !allowedCapabilities.has(capability),
    );
    if (denied.length > 0) {
      results.push({
        doctorId: doctor.id,
        result: skipped(`Doctor requires denied capabilities: ${denied.join(", ")}.`),
      });
      continue;
    }

    const startedAt = Date.now();
    try {
      if (!await doctor.supports(snapshot)) {
        results.push({
          doctorId: doctor.id,
          result: skipped("Doctor does not support this project snapshot."),
        });
        continue;
      }

      results.push({ doctorId: doctor.id, result: await doctor.diagnose(context) });
    } catch (error) {
      results.push({ doctorId: doctor.id, result: failure(error, startedAt) });
    }
  }

  return results;
}
