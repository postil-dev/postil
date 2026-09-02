import { describe, expect, test } from "bun:test";

import {
  ALERT_TRIGGER_TYPES,
  canaryAlertKey,
  desiredAlertAction,
  equivalentAlertAction,
  finalizeIlertWebhookCanary,
  type Fetch,
  parseReceiverOrigin,
  reconcileIlertAlertAction,
  runCli,
  verifyIlertWebhookCanary,
} from "../scripts/reconcile-ilert-alert-stream";

const API_KEY = "test-api-key";
const INTEGRATION_KEY = "test-integration-key";
const SOURCE_ID = 42;
const RECEIVER_ORIGIN = "https://postil.example";
const WEBHOOK_SECRET = "test-webhook-secret-with-at-least-32-bytes";
const RUN_ID = "12345";
const SOURCE = {
  id: SOURCE_ID,
  name: "Postil test source",
  integrationType: "API",
  escalationPolicy: {
    id: 7,
    name: "Test escalation",
    escalationRules: [],
  },
};

const reconcileOptions = {
  apiKey: API_KEY,
  integrationKey: INTEGRATION_KEY,
  receiverOrigin: RECEIVER_ORIGIN,
  sourceId: SOURCE_ID,
  webhookSecret: WEBHOOK_SECRET,
};

const canaryOptions = {
  ...reconcileOptions,
  runId: RUN_ID,
  sleep: async () => undefined,
};

describe("iLert webhook-action reconciliation", () => {
  test("builds an unfiltered default-body action for a documented API source", () => {
    const secret = "test-webhook-secret-with-special-:/?#%value";
    const desired = desiredAlertAction(SOURCE, secret, RECEIVER_ORIGIN);
    expect(desired).toMatchObject({
      alertSources: [{ id: SOURCE_ID }],
      connectorType: "webhook",
      conditions: "",
      name: "Postil operator alert stream",
      triggerMode: "AUTOMATIC",
      triggerTypes: [...ALERT_TRIGGER_TYPES],
      params: {
        bodyTemplate: "",
        webhookUrl:
          "https://postil-ilert:test-webhook-secret-with-special-%3A%2F%3F%23%25value@postil.example/api/webhooks/ilert",
      },
    });
  });

  test("includes hidden conditions and custom body templates in equivalence", () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const actual = structuredClone(desired) as Record<string, unknown>;
    actual.id = "42";
    actual.triggerTypes = [...ALERT_TRIGGER_TYPES].reverse();
    expect(equivalentAlertAction(actual, desired)).toBe(true);

    actual.conditions = "alert.priority == 'HIGH'";
    expect(equivalentAlertAction(actual, desired)).toBe(false);
    actual.conditions = "";
    (actual.params as Record<string, unknown>).bodyTemplate = "{}";
    expect(equivalentAlertAction(actual, desired)).toBe(false);
    (actual.params as Record<string, unknown>).bodyTemplate = "";
    (actual.params as Record<string, unknown>).headers = [
      { key: "Authorization", value: "unsupported" },
    ];
    expect(equivalentAlertAction(actual, desired)).toBe(false);
  });

  test("rejects receiver URLs with unsafe schemes, credentials, or non-origin data", () => {
    expect(parseReceiverOrigin("https://postil.example/")).toBe(RECEIVER_ORIGIN);
    for (const value of [
      "http://postil.example",
      "https://user:password@postil.example",
      "https://postil.example/path",
      "https://postil.example?query=1",
      "https://postil.example/#fragment",
    ]) {
      expect(() => parseReceiverOrigin(value)).toThrow("HTTPS origin");
    }
  });

  test("requires the configured source to be an Event API source before action lookup", async () => {
    const requests: Request[] = [];
    await expect(
      reconcileIlertAlertAction({
        ...reconcileOptions,
        fetchFn: queuedFetch(requests, [
          Response.json({ ...SOURCE, integrationType: "GITHUB" }),
        ]),
      }),
    ).rejects.toThrow("configured identity");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain(`/alert-sources/${SOURCE_ID}`);
    expect(requests[0]!.method).toBe("GET");
  });

  test("uses the source filter and avoids detail calls for unrelated actions", async () => {
    const requests: Request[] = [];
    const unrelated = Array.from({ length: 100 }, (_, index) => ({
      id: String(index + 1),
      name: `Unrelated action ${index + 1}`,
      params: { webhookUrl: `https://example.test/${index + 1}` },
    }));
    const result = await reconcileIlertAlertAction({
      ...reconcileOptions,
      dryRun: true,
      fetchFn: queuedFetch(requests, [
        Response.json(SOURCE),
        Response.json(unrelated),
        Response.json([]),
      ]),
    });
    expect(result).toEqual({ actionId: null, operation: "create" });
    expect(requests).toHaveLength(3);
    expect(requests[1]!.url).toContain("source=42");
    expect(requests[2]!.url).toContain("start-index=100");
  });

  test("requests conditions and reconciles condition and body-template drift", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const drifted = {
      ...desired,
      conditions: "alert.priority == 'HIGH'",
      id: "72",
      params: { ...(desired.params as object), bodyTemplate: "{}" },
    };
    const requests: Request[] = [];
    const result = await reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: queuedFetch(requests, [
        Response.json(SOURCE),
        Response.json([{ id: "72", name: desired.name }]),
        Response.json(drifted),
        new Response(null, { status: 204 }),
        Response.json({ ...desired, id: "72" }),
        Response.json({ ...desired, id: "72" }),
      ]),
    });
    expect(result).toEqual({ actionId: "72", operation: "update" });
    expect(requests[2]!.url).toContain("include=conditions");
    expect(requests[3]!.url).toBe(
      `${RECEIVER_ORIGIN}/api/webhooks/ilert`,
    );
    expect(requests[3]!.headers.get("authorization")).toStartWith("Basic ");
    expect(requests[4]!.method).toBe("PUT");
    expect(requests[4]!.url).toContain("include=conditions");
    const body = await requests[4]!.json() as Record<string, unknown>;
    expect(body.conditions).toBe("");
    expect(body.params).toMatchObject({ bodyTemplate: "" });
  });

  test("does not persist a credential when the deployed receiver rejects preflight", async () => {
    const requests: Request[] = [];
    await expect(
      reconcileIlertAlertAction({
        ...reconcileOptions,
        fetchFn: queuedFetch(requests, [
          Response.json(SOURCE),
          Response.json([]),
          Response.json({ error: "unauthorized" }, { status: 401 }),
        ]),
      }),
    ).rejects.toThrow("credential preflight failed with HTTP 401");
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
    ]);
    expect(requests.some((request) => request.url.includes("/alert-actions") && request.method !== "GET")).toBe(false);
  });

  test("creates a missing action only after receiver preflight", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    const result = await reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: queuedFetch(requests, [
        Response.json(SOURCE),
        Response.json([]),
        new Response(null, { status: 204 }),
        Response.json({ id: "71" }),
        Response.json({ ...desired, id: "71" }),
      ]),
    });
    expect(result).toEqual({ actionId: "71", operation: "create" });
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "GET",
    ]);
    const body = await requests[3]!.json() as {
      alertSources: Array<Record<string, unknown>>;
    };
    expect(body.alertSources[0]).not.toHaveProperty("integrationKey");
  });

  test("bounds 429 handling and honors a capped Retry-After delay", async () => {
    const requests: Request[] = [];
    const sleeps: number[] = [];
    const result = await reconcileIlertAlertAction({
      ...reconcileOptions,
      dryRun: true,
      fetchFn: queuedFetch(requests, [
        new Response(null, { status: 429, headers: { "retry-after": "60" } }),
        Response.json(SOURCE),
        Response.json([]),
      ]),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    expect(result.operation).toBe("create");
    expect(sleeps).toEqual([10_000]);
    expect(requests).toHaveLength(3);
  });

  test("reports only an HTTP status when a provider request is rejected", async () => {
    const providerBody = "provider response containing credential material";
    try {
      await reconcileIlertAlertAction({
        ...reconcileOptions,
        fetchFn: async () => new Response(providerBody, { status: 403 }),
      });
      throw new Error("expected reconciliation to fail");
    } catch (error) {
      expect(String(error)).toContain("HTTP 403");
      expect(String(error)).not.toContain(providerBody);
    }
  });
});

describe("iLert webhook canary", () => {
  test("uses one run-stable key across rerun attempts and pre-cleans an open alert", async () => {
    expect(canaryAlertKey(RUN_ID)).toBe("postil-ilert-webhook-canary-12345");
    const service = canaryService({ existing: true, status: "PENDING" });
    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
    });
    expect(service.events.map((event) => event.eventType)).toEqual([
      "RESOLVE",
      "ALERT",
      "RESOLVE",
    ]);
    expect(service.events.every((event) => event.alertKey === canaryAlertKey(RUN_ID))).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED", "RESOLVED"]);
  });

  test("rejects a non-API source before ALERT", async () => {
    const service = canaryService({ sourceIntegrationType: "GITHUB" });
    await expect(
      verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: service.fetchFn,
      }),
    ).rejects.toThrow("configured identity");
    expect(service.events).toHaveLength(0);
  });

  test("submits same-key RESOLVE cleanup when management fails after ALERT", async () => {
    const service = canaryService({ managementFailsAfterAlert: true });
    await expect(
      verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: service.fetchFn,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(service.events[0]).toEqual({
      alertKey: canaryAlertKey(RUN_ID),
      eventType: "ALERT",
    });
    expect(service.events.some((event) => event.eventType === "RESOLVE")).toBe(true);
    expect(new Set(service.events.map((event) => event.alertKey))).toEqual(
      new Set([canaryAlertKey(RUN_ID)]),
    );
  });

  test("retries transient RESOLVE and receiver observation failures", async () => {
    const service = canaryService({
      receiverObservationFailures: 2,
      resolveRequestFailures: 2,
    });
    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
    });
    expect(service.events.filter((event) => event.eventType === "RESOLVE")).toHaveLength(3);
    expect(service.receiverObservationRequests).toBeGreaterThanOrEqual(4);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("requires exact persisted alert-resolved evidence, not action-history growth", async () => {
    const service = canaryService({ dropResolvedReceiverEvent: true });
    await expect(
      verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: service.fetchFn,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(service.requests.some((request) => request.url.endsWith("/actions"))).toBe(false);
    expect(service.requests.some((request) => request.url.includes("eventType=alert-resolved"))).toBe(true);
  });

  test("requires receiver evidence at the configured alert-source id", async () => {
    const service = canaryService({ observedSourceId: SOURCE_ID + 1 });
    await expect(
      verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: service.fetchFn,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    const observationRequests = service.requests.filter((request) =>
      request.url.startsWith(`${RECEIVER_ORIGIN}/api/webhooks/ilert?`),
    );
    expect(observationRequests.length).toBeGreaterThan(0);
    expect(observationRequests.every((request) =>
      new URL(request.url).searchParams.get("sourceId") === String(SOURCE_ID),
    )).toBe(true);
  });

  test("finalizer polls through asynchronous discovery before resolving", async () => {
    const service = canaryService({
      existing: true,
      deferredListings: 2,
      status: "PENDING",
    });
    await finalizeIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
    });
    expect(service.alertListRequests).toBeGreaterThanOrEqual(3);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("finalizer no-ops only after a durable no-ALERT handoff", async () => {
    const service = canaryService();
    await finalizeIlertWebhookCanary({
      ...canaryOptions,
      alertSubmitted: false,
      fetchFn: service.fetchFn,
    });
    expect(service.alertListRequests).toBe(0);
    expect(service.events).toHaveLength(0);
  });

  test("finalizer resolves then fails closed when canary discovery stays unknown", async () => {
    const service = canaryService();
    await expect(
      finalizeIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: service.fetchFn,
      }),
    ).rejects.toThrow("could not establish whether the submitted alert exists");
    expect(service.alertListRequests).toBe(61);
    expect(service.events).toEqual([{
      alertKey: canaryAlertKey(RUN_ID),
      eventType: "RESOLVE",
    }]);
  });

  test("finalizer CLI is cleanup-only and never reads or mutates alert actions", async () => {
    const service = canaryService({ existing: true, status: "PENDING" });
    await runCli({
      args: ["--finalize-canary"],
      env: cliEnvironment(),
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
      log: () => undefined,
    });
    expect(service.requests.some((request) => request.url.includes("/alert-actions"))).toBe(false);
    expect(service.events.some((event) => event.eventType === "ALERT")).toBe(false);
    expect(service.events.some((event) => event.eventType === "RESOLVE")).toBe(true);
  });
});

function cliEnvironment(): Record<string, string> {
  return {
    ILERT_API_KEY: API_KEY,
    ILERT_INTEGRATION_KEY: INTEGRATION_KEY,
    POSTIL_ILERT_ALERT_SOURCE_ID: String(SOURCE_ID),
    POSTIL_ILERT_CANARY_RUN_ID: RUN_ID,
    POSTIL_ILERT_RECEIVER_ORIGIN: RECEIVER_ORIGIN,
    POSTIL_ILERT_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
}

function canaryService(options: {
  deferredListings?: number;
  dropResolvedReceiverEvent?: boolean;
  existing?: boolean;
  managementFailsAfterAlert?: boolean;
  observedSourceId?: number;
  receiverObservationFailures?: number;
  resolveRequestFailures?: number;
  sourceIntegrationType?: string;
  status?: "PENDING" | "RESOLVED";
} = {}) {
  const events: Array<{ alertKey: string; eventType: string }> = [];
  const requests: Request[] = [];
  const alerts: Array<{
    createdReceived: boolean;
    id: number;
    resolvedReceived: boolean;
    status: "PENDING" | "RESOLVED";
  }> = options.existing
    ? [{
        createdReceived: true,
        id: 98,
        resolvedReceived: options.status === "RESOLVED",
        status: options.status ?? "PENDING",
      }]
    : [];
  let alertSent = false;
  let alertListRequests = 0;
  let receiverObservationFailures = options.receiverObservationFailures ?? 0;
  let receiverObservationRequests = 0;
  let resolveRequestFailures = options.resolveRequestFailures ?? 0;

  const fetchFn: Fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.endsWith(`/alert-sources/${SOURCE_ID}`)) {
      return Response.json({
        ...SOURCE,
        integrationType: options.sourceIntegrationType ?? SOURCE.integrationType,
      });
    }
    if (request.method === "POST" && request.url.endsWith("/events")) {
      const body = await request.json() as { alertKey: string; eventType: string };
      events.push({ alertKey: body.alertKey, eventType: body.eventType });
      if (body.eventType === "ALERT") {
        alertSent = true;
        const id = alerts.length === 0
          ? 99
          : Math.max(...alerts.map((alert) => alert.id)) + 1;
        alerts.push({
          createdReceived: true,
          id,
          resolvedReceived: false,
          status: "PENDING",
        });
      }
      if (body.eventType === "RESOLVE") {
        if (resolveRequestFailures > 0) {
          resolveRequestFailures -= 1;
          return new Response(null, { status: 503 });
        }
        for (const alert of alerts.filter((item) => item.status !== "RESOLVED")) {
          alert.status = "RESOLVED";
          if (!options.dropResolvedReceiverEvent) alert.resolvedReceived = true;
        }
      }
      return new Response(null, { status: 202 });
    }
    if (request.url.includes("/alerts?")) {
      alertListRequests += 1;
      if (options.managementFailsAfterAlert && alertSent) {
        return new Response(null, { status: 503 });
      }
      if (alertListRequests <= (options.deferredListings ?? 0)) {
        return Response.json([]);
      }
      return Response.json(alerts.map((alert) => ({
        alertKey: canaryAlertKey(RUN_ID),
        id: alert.id,
        status: alert.status,
      })));
    }
    if (request.url.startsWith(`${RECEIVER_ORIGIN}/api/webhooks/ilert?`)) {
      receiverObservationRequests += 1;
      if (receiverObservationFailures > 0) {
        receiverObservationFailures -= 1;
        return new Response(null, { status: 503 });
      }
      const query = new URL(request.url).searchParams;
      const alert = alerts.find((item) => String(item.id) === query.get("alertId"));
      const received = query.get("sourceId") === String(options.observedSourceId ?? SOURCE_ID) &&
        (query.get("eventType") === "alert-created"
        ? alert?.createdReceived === true
        : alert?.resolvedReceived === true);
      return Response.json({ received });
    }
    if (request.url.endsWith("/actions")) {
      return Response.json({
        alertActionId: "72",
        history: [{ alertActionId: "72", alertId: 99, id: "untyped", success: true }],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  };

  return {
    events,
    fetchFn,
    requests,
    get alertListRequests() {
      return alertListRequests;
    },
    get receiverObservationRequests() {
      return receiverObservationRequests;
    },
    get statuses() {
      return alerts.map((alert) => alert.status);
    },
  };
}

function queuedFetch(requests: Request[], responses: Response[]): Fetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
}
