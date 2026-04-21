import { PostHog } from "posthog-node";
import { env } from "@/lib/env";

let _client: PostHog | undefined;

export function posthog(): PostHog | undefined {
  if (!env.POSTHOG_API_KEY) return undefined;
  if (!_client) {
    _client = new PostHog(env.POSTHOG_API_KEY, {
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

export async function shutdownPosthog(): Promise<void> {
  if (_client) await _client.shutdown();
}
