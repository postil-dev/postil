import { PostHog } from "posthog-node";
import { env } from "@/lib/env";

let _client: PostHog | undefined;

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hashInstallationId(installationId: number): Promise<string> {
  const salt = env.POSTHOG_PROJECT_TOKEN ?? "postil-default-salt";
  return (await sha256Hex(`${installationId}:${salt}`)).slice(0, 16);
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
