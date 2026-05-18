import { env } from "@/lib/env";
import { runSmokeTest, shutdownPosthog } from "@/lib/posthog";

export async function register() {
  if (env.NODE_ENV !== "production") {
    try {
      await runSmokeTest();
    } catch (err) {
      console.error("[instrumentation] PostHog smoke test failed:", err);
    }
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      console.log(`[instrumentation] Received ${signal}, flushing PostHog...`);
      await shutdownPosthog();
      process.exit(0);
    });
  }
}
