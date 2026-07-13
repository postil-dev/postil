import type { Instrumentation } from "next";

/**
 * Web process boot validation. Next.js calls register() when the server
 * starts; we fail fast with an actionable list of missing env vars instead
 * of failing later on the first request. Skipped during `next build`, which
 * must not require a live environment.
 */
export function register(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.POSTIL_SKIP_ENV_VALIDATION === "1") return;
  const { registerNodeInstrumentation } = require("./instrumentation-node") as typeof import("./instrumentation-node");
  registerNodeInstrumentation();
}

export const onRequestError: Instrumentation.onRequestError = (error) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportNodeRequestError } = require("./instrumentation-node") as typeof import("./instrumentation-node");
  reportNodeRequestError(error);
};
