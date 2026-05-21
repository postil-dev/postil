import { env } from "@/lib/env";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { runSmokeTest, shutdownPosthog } = await import("@/lib/posthog");

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
