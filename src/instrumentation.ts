import { env } from "@/lib/env";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { installNodeInstrumentation } = await import("@/instrumentation-node");
  const { runSmokeTest } = await import("@/lib/posthog");

  if (env.NODE_ENV !== "production") {
    try {
      await runSmokeTest();
    } catch (err) {
      console.error("[instrumentation] PostHog smoke test failed:", err);
    }
  }

  installNodeInstrumentation();
}
