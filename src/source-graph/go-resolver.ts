import { posix } from "node:path";
import type { DetectedProject } from "../workspace/types.js";
import { isGoSourcePath, type GoModuleInfo } from "./go-mod.js";
import { ownerProjectOf } from "./ownership.js";
import type { SourceResolution } from "./resolver.js";

export interface GoResolverContext {
  readonly projects: readonly DetectedProject[];
  readonly sourcePaths: ReadonlySet<string>;
  readonly goModules?: ReadonlyMap<string, GoModuleInfo>;
}

function packageFiles(directory: string, sourcePaths: ReadonlySet<string>): string[] {
  return [...sourcePaths]
    .filter((path) => isGoSourcePath(path) && posix.dirname(path) === directory)
    .sort((left, right) =>
      Number(left.endsWith("_test.go")) - Number(right.endsWith("_test.go")) ||
      left.localeCompare(right)
    );
}

export function resolveGoImport(
  importerPath: string,
  specifier: string,
  context: GoResolverContext,
): SourceResolution {
  if (specifier.length === 0 || specifier.includes("\0") || /\s/u.test(specifier)) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Go import specifier is unsupported.`],
    };
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: relative Go imports are not supported.`],
    };
  }

  const owner = ownerProjectOf(importerPath, context.projects);
  const module = owner === undefined ? undefined : context.goModules?.get(owner.root);
  if (module === undefined) {
    return {
      kind: "unsupported",
      limitations: [`${importerPath}: Go module path is unavailable; import was not resolved.`],
    };
  }

  let directory: string;
  if (specifier === module.modulePath) {
    directory = module.root;
  } else if (specifier.startsWith(`${module.modulePath}/`)) {
    const rest = specifier.slice(module.modulePath.length + 1).replaceAll("\\", "/");
    if (rest.length === 0 || rest === ".." || rest.startsWith("../") || posix.isAbsolute(rest)) {
      return {
        kind: "unsupported",
        limitations: [`${importerPath}: Go import escapes the module root.`],
      };
    }
    directory = module.root === "." ? rest : `${module.root}/${rest}`;
  } else {
    return { kind: "external", limitations: [] };
  }

  const files = packageFiles(directory, context.sourcePaths);
  if (files.length > 0) {
    return { kind: "internal", targetPath: files[0]!, targetExists: true, limitations: [] };
  }
  return {
    kind: "internal",
    targetPath: directory,
    targetExists: false,
    ...(module.hasReplace ? {} : { missingTargetProof: "module-internal" as const }),
    limitations: [
      module.hasReplace
        ? `${importerPath}: internal Go package is not present in the current inventory; a replace directive may redirect it.`
        : `${importerPath}: internal Go package is not present in the current inventory.`,
    ],
  };
}
