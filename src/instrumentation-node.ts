import { validateEnv } from "@/lib/env";
import { reportOperationalFailure } from "@/lib/server-observability";

export function registerNodeInstrumentation(): void {
  validateEnv("web");
}

export function reportNodeRequestError(error: unknown): void {
  reportOperationalFailure("web", "web_request_failed", error);
}
