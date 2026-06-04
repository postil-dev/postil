import { shutdownPosthog } from "@/lib/posthog";

let installed = false;

export function installNodeInstrumentation() {
  if (installed) return;
  installed = true;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      console.log(`[instrumentation] Received ${signal}, flushing PostHog...`);
      await shutdownPosthog();
      process.exit(0);
    });
  }
}
