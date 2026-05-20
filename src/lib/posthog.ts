import { PostHog } from "posthog-node";
import { env } from "@/lib/env";

let _client: PostHog | undefined;

function stableHexHash(input: string): string {
  let high = 0x811c9dc5;
  let low = 0x1000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    high = Math.imul(high ^ code, 0x01000193);
    low = Math.imul(low ^ code, 0x85ebca6b);
  }
  return `${(high >>> 0).toString(16).padStart(8, "0")}${(low >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function hashInstallationId(installationId: number): string {
  const salt = env.POSTHOG_PROJECT_TOKEN ?? "postil-default-salt";
  return stableHexHash(`${installationId}:${salt}`);
}

export function posthog(): PostHog | undefined {
  if (!env.POSTHOG_PROJECT_TOKEN) return undefined;
  if (!_client) {
    _client = new PostHog(env.POSTHOG_PROJECT_TOKEN, {
      host: env.POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return _client;
}

export function track(
  userId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  const p = posthog();
  if (!p) return;
  p.capture({ distinctId: userId, event, properties });
}

export function captureException(
  err: unknown,
  context?: { userId?: string; properties?: Record<string, unknown> },
): void {
  const p = posthog();
  if (!p) {
    console.error("[posthog-disabled]", err);
    return;
  }
  const error = err instanceof Error ? err : new Error(String(err));
  p.captureException(error, context?.userId ?? "anonymous", context?.properties);
}

export async function runSmokeTest(): Promise<void> {
  const p = posthog();
  if (!p) {
    console.warn("[posthog] smoke test skipped (POSTHOG_PROJECT_TOKEN not set)");
    return;
  }

  try {
    track("system", "smoke_test_boot", {
      timestamp: Date.now(),
      source: "postil-server",
    });
    await p.flush();
    console.log("[posthog] smoke test event flushed successfully");
  } catch (err) {
    console.error("[posthog] smoke test failed to flush:", err);
    captureException(err, {
      properties: { op: "posthog_smoke_test" },
    });
    throw err;
  }
}

export async function shutdownPosthog(): Promise<void> {
  if (_client) await _client.shutdown();
}
