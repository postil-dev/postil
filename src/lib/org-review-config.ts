import { parse } from "yaml";

/** Validate an authorable `.postil.yaml` body before it reaches storage. */
export function validateOrgConfigYaml(configYaml: string): void {
  try {
    parse(configYaml);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Config YAML is invalid: ${detail}`);
  }
}
