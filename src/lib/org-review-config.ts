import { parse, stringify } from "yaml";

function parseConfig(configYaml: string): unknown {
  try {
    return parse(configYaml);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Config YAML is invalid: ${detail}`);
  }
}

/** Validate an authorable `.postil.yaml` body before it reaches storage. */
export function validateOrgConfigYaml(configYaml: string): void {
  const config = parseConfig(configYaml);
  if (isRecord(config) && Object.hasOwn(config, "model")) {
    throw new Error(
      "Organization fallback config cannot set model options. Configure inference under Bring your own key.",
    );
  }
}

/**
 * Remove model settings from rows saved before provider settings became BYOK-only.
 * Save-time validation prevents new rows; this worker-boundary filter prevents a
 * legacy organization fallback from overriding hosted inference.
 */
export function withoutOrgModelConfig(configYaml: string | null): string | null {
  return withoutModelConfig(configYaml);
}

/** Remove a model block while retaining every non-inference setting. */
export function withoutModelConfig(
  configYaml: string | null,
  outputFormat: "yaml" | "json" = "yaml",
): string | null {
  if (configYaml === null) return null;
  const config = parseConfig(configYaml);
  if (!isRecord(config) || !Object.hasOwn(config, "model")) return configYaml;
  const sanitized = { ...config };
  delete sanitized.model;
  if (Object.keys(sanitized).length === 0) return null;
  return outputFormat === "json"
    ? `${JSON.stringify(sanitized, null, 2)}\n`
    : stringify(sanitized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
