import { describe, expect, test } from "bun:test";

import {
  configuredMonitoringAlertTransport,
  ilertEventTransport,
  withFallbackTransport,
  type OperatorNotification,
  type OperatorNotificationTransport,
} from "@/lib/operator-notifications";

function notification(
  overrides: Partial<OperatorNotification> = {},
): OperatorNotification {
  return {
    recipient: "operator@example.test",
    subject: "[critical] Postil monitor: Review worker heartbeat is stale",
    content: {
      preheader: "preheader",
      category: "Production monitor",
      title: "Review worker heartbeat is stale",
      summary: "Review worker fleet needs operator attention.",
      reason: "reason",
      details: [
        { label: "Affected capability", value: "Review worker fleet" },
        { label: "Severity", value: "critical" },
      ],
      action: {
        label: "Open private monitoring",
        url: "https://postil.dev/operator#monitoring",
      },
    },
    idempotencyKey: "notification-key-1",
    incident: { key: "worker-heartbeat", state: "open", critical: true },
    ...overrides,
  };
}

describe("ilert event transport", () => {
  test("maps an open incident to a HIGH priority ALERT with the incident alertKey", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const transport = ilertEventTransport("il-key", (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response("", { status: 202 });
    }) as typeof fetch);

    await transport.send(notification());

    expect(captured!.url).toBe("https://api.ilert.com/api/events");
    expect(captured!.body).toEqual({
      integrationKey: "il-key",
      eventType: "ALERT",
      summary: "[critical] Postil monitor: Review worker heartbeat is stale",
      details: [
        "Review worker fleet needs operator attention.",
        "Affected capability: Review worker fleet",
        "Severity: critical",
        "Open private monitoring: https://postil.dev/operator#monitoring",
      ].join("\n"),
      alertKey: "worker-heartbeat",
      priority: "HIGH",
    });
  });

  test("maps a resolved incident to a RESOLVE event without priority", async () => {
    let body: Record<string, unknown> = {};
    const transport = ilertEventTransport("il-key", (async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      body = JSON.parse(String(init?.body));
      return new Response("", { status: 202 });
    }) as typeof fetch);

    await transport.send(
      notification({
        incident: { key: "worker-heartbeat", state: "resolved", critical: true },
      }),
    );

    expect(body.eventType).toBe("RESOLVE");
    expect(body.alertKey).toBe("worker-heartbeat");
    expect(body).not.toHaveProperty("priority");
  });

  test("maps a warning incident to LOW priority", async () => {
    let body: Record<string, unknown> = {};
    const transport = ilertEventTransport("il-key", (async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      body = JSON.parse(String(init?.body));
      return new Response("", { status: 202 });
    }) as typeof fetch);

    await transport.send(
      notification({
        incident: { key: "billing-delay", state: "open", critical: false },
      }),
    );

    expect(body.priority).toBe("LOW");
  });

  test("falls back to the idempotency key when no incident is attached", async () => {
    let body: Record<string, unknown> = {};
    const transport = ilertEventTransport("il-key", (async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      body = JSON.parse(String(init?.body));
      return new Response("", { status: 202 });
    }) as typeof fetch);

    await transport.send(notification({ incident: undefined }));

    expect(body.eventType).toBe("ALERT");
    expect(body.alertKey).toBe("notification-key-1");
  });

  test("throws on a non-2xx response so delivery is retried", async () => {
    const transport = ilertEventTransport("il-key", (async () =>
      new Response("bad request", { status: 400 })) as unknown as typeof fetch);

    await expect(transport.send(notification())).rejects.toThrow(
      "ilert event delivery failed with HTTP 400",
    );
  });
});

describe("fallback transport", () => {
  const recording = (
    log: string[],
    label: string,
    failure?: string,
  ): OperatorNotificationTransport => ({
    async send(message) {
      log.push(`${label}:${message.idempotencyKey}`);
      if (failure) throw new Error(failure);
      return { messageId: `${label}-message` };
    },
  });

  test("uses only the primary transport when it succeeds", async () => {
    const log: string[] = [];
    const transport = withFallbackTransport(
      recording(log, "primary"),
      recording(log, "fallback"),
      () => log.push("fallback-invoked"),
    );

    expect(await transport.send(notification())).toEqual({
      messageId: "primary-message",
    });
    expect(log).toEqual(["primary:notification-key-1"]);
  });

  test("delivers through the fallback when the primary rejects the event", async () => {
    const log: string[] = [];
    const reasons: string[] = [];
    const transport = withFallbackTransport(
      recording(log, "primary", "ilert event delivery failed with HTTP 402: no access"),
      recording(log, "fallback"),
      (error) => reasons.push(String(error)),
    );

    expect(await transport.send(notification())).toEqual({
      messageId: "fallback-message",
    });
    expect(log).toEqual([
      "primary:notification-key-1",
      "fallback:notification-key-1",
    ]);
    expect(reasons).toEqual([
      "Error: ilert event delivery failed with HTTP 402: no access",
    ]);
  });

  test("surfaces both failures when the fallback also fails", async () => {
    const log: string[] = [];
    const transport = withFallbackTransport(
      recording(log, "primary", "primary down"),
      recording(log, "fallback", "email down"),
      () => undefined,
    );

    await expect(transport.send(notification())).rejects.toThrow(
      "primary alert delivery failed (primary down); fallback delivery failed (email down)",
    );
  });
});

describe("configured monitoring alert transport", () => {
  test("fails closed when no integration key is configured", async () => {
    const previous = process.env.ILERT_INTEGRATION_KEY;
    delete process.env.ILERT_INTEGRATION_KEY;
    try {
      await expect(
        configuredMonitoringAlertTransport().send(notification()),
      ).rejects.toThrow(
        "ILERT_INTEGRATION_KEY is required for monitoring alert delivery",
      );
    } finally {
      if (previous !== undefined) process.env.ILERT_INTEGRATION_KEY = previous;
    }
  });
});
