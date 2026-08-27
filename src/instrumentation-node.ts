import { validateEnv } from "@/lib/env";
import { reportOperationalFailure } from "@/lib/server-observability";

export function registerNodeInstrumentation(): void {
  if (process.env.POSTIL_SKIP_ENV_VALIDATION === "1") return;
  validateEnv("web");
  const bootProbe = process.env.POSTIL_BOOT_PROBE;
  if (bootProbe) process.env.POSTIL_BOOT_PROBE_READY = bootProbe;
}

export function reportNodeRequestError(error: unknown): void {
  reportOperationalFailure("web", "web_request_failed", error);
}
