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
  sourceBindingProbeKey,
  verifyIlertWebhookCanary,
} from "../scripts/reconcile-ilert-alert-stream";

const API_KEY = "test-api-key";
const INTEGRATION_KEY = "test-integration-key";
const SOURCE_ID = 42;
const RECEIVER_ORIGIN = "https://postil.example";
const WEBHOOK_SECRET = "test-webhook-secret-with-at-least-32-bytes";
const RUN_ID = "12345";
const RUN_ATTEMPT = "1";
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
  runAttempt: RUN_ATTEMPT,
  runId: RUN_ID,
  sourceId: SOURCE_ID,
  sleep: async () => undefined,
  webhookSecret: WEBHOOK_SECRET,
};

const canaryOptions = {
  ...reconcileOptions,
  runAttempt: RUN_ATTEMPT,
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

  test("rejects a mismatched Event API route before action mutation and resolves its probe", async () => {
    const requests: Request[] = [];
    let probe: { key: string; status: "PENDING" | "RESOLVED" } | undefined;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith(`/alert-sources/${SOURCE_ID}`)) return Response.json(SOURCE);
      if (request.url.includes("/alert-actions?")) return Response.json([]);
      if (request.url.endsWith("/events")) {
        const body = await request.json() as { alertKey: string; eventType: string };
        if (body.eventType === "ALERT") probe = { key: body.alertKey, status: "PENDING" };
        if (body.eventType === "RESOLVE" && probe?.key === body.alertKey) probe.status = "RESOLVED";
        return new Response(null, { status: 202 });
      }
      if (request.url.endsWith("/alerts/91") && probe) {
        return Response.json({
          alertKey: probe.key,
          alertSource: { id: SOURCE_ID + 1 },
          id: 91,
          priority: "LOW",
          status: probe.status,
        });
      }
      if (request.url.includes("/alerts?")) {
        return Response.json(probe ? [{
          alertKey: probe.key,
          alertSource: { id: SOURCE_ID + 1 },
          id: 91,
          priority: "LOW",
          status: probe.status,
        }] : []);
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    await expect(reconcileIlertAlertAction({ ...reconcileOptions, fetchFn }))
      .rejects.toThrow("does not route to the configured alert source");
    expect(requests.filter((request) =>
      request.url.includes("/alert-actions") && request.method !== "GET"
    )).toHaveLength(0);
    expect(probe?.status).toBe("RESOLVED");
  });

  test("scans the global inventory and avoids detail calls for unrelated actions", async () => {
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
    expect(requests[1]!.url).not.toContain("source=");
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
        Response.json([{ id: "72", name: String(desired.name) }]),
        Response.json(drifted),
        new Response(null, { status: 204 }),
        Response.json({ ...desired, id: "72" }),
        Response.json({ ...desired, id: "72" }),
      ]),
    });
    expect(result).toEqual({ actionId: "72", operation: "update" });
    expect(requests[2]!.url).toContain("include=conditions");
    const preflight = requests.find((request) => request.url === `${RECEIVER_ORIGIN}/api/webhooks/ilert`);
    expect(preflight?.headers.get("authorization")).toStartWith("Basic ");
    const update = requests.find((request) => request.method === "PUT");
    expect(update?.url).toContain("include=conditions");
    const resolvedProbeDetail = requests.findIndex((request) =>
      request.url.endsWith("/alerts/991")
    );
    expect(resolvedProbeDetail).toBeGreaterThan(-1);
    expect(resolvedProbeDetail).toBeLessThan(requests.indexOf(preflight!));
    expect(resolvedProbeDetail).toBeLessThan(requests.indexOf(update!));
    const body = await update!.json() as Record<string, unknown>;
    expect(body.conditions).toBe("");
    expect(body.params).toMatchObject({ bodyTemplate: "" });
  });

  test("clears an active deprecated alertFilter and verifies its removal", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const legacy = {
      ...desired,
      alertFilter: { operator: "AND", predicates: [{ field: "ALERT_SUMMARY" }] },
      id: "72",
    };
    const requests: Request[] = [];
    await reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: queuedFetch(requests, [
        Response.json(SOURCE),
        Response.json([{ id: "72", name: String(desired.name) }]),
        Response.json(legacy),
        new Response(null, { status: 204 }),
        Response.json({ ...desired, id: "72" }),
        Response.json({ ...desired, id: "72" }),
      ]),
    });
    const update = requests.find((request) => request.method === "PUT");
    expect(update).toBeDefined();
    expect(await update!.json()).toMatchObject({ alertFilter: null, conditions: "" });
  });

  test("runs the receiver and deterministic source-binding preflights for an equivalent action", async () => {
    const desired = { ...desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN), id: "72" };
    const actionName = "Postil operator alert stream";
    const requests: Request[] = [];
    const result = await reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: queuedFetch(requests, [
        Response.json(SOURCE),
        Response.json([{ id: "72", name: actionName }]),
        Response.json(desired),
        new Response(null, { status: 204 }),
      ]),
    });
    expect(result).toEqual({ actionId: "72", operation: "unchanged" });
    const events = await Promise.all(requests.filter((request) =>
      request.url.endsWith("/events")
    ).map(async (request) => request.json() as Promise<{ alertKey: string; eventType: string }>));
    expect(events.map(({ alertKey, eventType }) => ({ alertKey, eventType }))).toEqual([
      { alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT), eventType: "ALERT" },
      { alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT), eventType: "RESOLVE" },
      { alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT), eventType: "RESOLVE" },
    ]);
    expect(requests.some((request) => request.url === `${RECEIVER_ORIGIN}/api/webhooks/ilert`)).toBe(true);
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
  });

  test("finds a reserved action globally when its source scope drifted", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      dryRun: true,
      fetchFn: queuedFetch(requests, [
        Response.json(SOURCE),
        Response.json([{ id: "72", name: desired.name }]),
        Response.json({ ...desired, alertSources: [{ id: SOURCE_ID + 1 },], id: "72" }),
      ]),
    })).rejects.toThrow("conflicting Postil alert action");
    expect(requests[1]!.url).not.toContain("source=");
  });

  test("uses the deterministic binding key for cleanup after its discovery deadline and lets the finalizer reconstruct it", async () => {
    const events: Array<{ alertKey: string; eventType: string }> = [];
    let currentTime = 0;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith(`/alert-sources/${SOURCE_ID}`)) return Response.json(SOURCE);
      if (request.url.includes("/alert-actions?")) return Response.json([]);
      if (request.url.endsWith("/events")) {
        events.push(await request.json() as { alertKey: string; eventType: string });
        return new Response(null, { status: 202 });
      }
      if (request.url.includes("/alerts?")) return Response.json([]);
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    })).rejects.toThrow("probe cleanup could not be verified");
    expect(events.map(({ alertKey, eventType }) => ({ alertKey, eventType }))).toEqual([
      { alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT), eventType: "ALERT" },
      { alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT), eventType: "RESOLVE" },
    ]);
    await finalizeIlertWebhookCanary({
      ...canaryOptions,
      fetchFn,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    expect(events.map(({ alertKey, eventType }) => ({ alertKey, eventType }))).toEqual(expect.arrayContaining([
      { alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT), eventType: "RESOLVE" },
      { alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT), eventType: "RESOLVE" },
    ]));
  });

  test("adopts one equivalent action after an ambiguous committed POST without retrying", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    let created = false;
    let probe: { key: string; status: "PENDING" | "RESOLVED" } | undefined;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith(`/alert-sources/${SOURCE_ID}`)) return Response.json(SOURCE);
      if (request.url.endsWith("/events")) {
        const body = await request.json() as { alertKey: string; eventType: string };
        if (body.eventType === "ALERT") probe = { key: body.alertKey, status: "PENDING" };
        if (body.eventType === "RESOLVE" && probe?.key === body.alertKey) probe.status = "RESOLVED";
        return new Response(null, { status: 202 });
      }
      if (request.url.endsWith("/alerts/991") && probe) {
        return Response.json({
          alertKey: probe.key,
          alertSource: { id: SOURCE_ID },
          id: 991,
          priority: "LOW",
          status: probe.status,
        });
      }
      if (request.url.includes("/alerts?")) {
        return Response.json(probe ? [{
          alertKey: probe.key,
          alertSource: { id: SOURCE_ID },
          id: 991,
          priority: "LOW",
          status: probe.status,
        }] : []);
      }
      if (request.url === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
      if (request.method === "POST" && request.url.includes("/alert-actions")) {
        created = true;
        throw new Error("connection reset after commit");
      }
      if (request.url.includes("/alert-actions")) {
        if (!created) return Response.json([]);
        if (request.url.includes("include=conditions")) return Response.json({ ...desired, id: "73" });
        return Response.json([{ id: "73", name: desired.name }]);
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    const result = await reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn,
      sleep: async () => undefined,
    });
    expect(result).toEqual({ actionId: "73", operation: "create" });
    expect(requests.filter((request) =>
      request.method === "POST" && request.url.includes("/alert-actions")
    )).toHaveLength(1);
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
    expect(requests.filter((request) => request.url.endsWith("/events"))).toHaveLength(3);
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
    const create = requests.find((request) =>
      request.method === "POST" && request.url.includes("/alert-actions"),
    );
    expect(create).toBeDefined();
    const body = await create!.json() as {
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
  test("uses unique deterministic keys for every workflow attempt", () => {
    expect(canaryAlertKey(RUN_ID, "1")).toBe(
      "postil-ilert-webhook-canary-12345-1",
    );
    expect(canaryAlertKey(RUN_ID, "2")).toBe(
      "postil-ilert-webhook-canary-12345-2",
    );
    expect(sourceBindingProbeKey(RUN_ID, "1")).not.toBe(
      sourceBindingProbeKey(RUN_ID, "2"),
    );
  });

  test("attempt 2 pre-cleans attempt 1 probe and main keys before its HIGH alert", async () => {
    const service = canaryService({
      initialAlerts: [
        {
          alertKey: sourceBindingProbeKey(RUN_ID, "1"),
          id: 97,
          priority: "LOW",
          status: "PENDING",
        },
        {
          alertKey: canaryAlertKey(RUN_ID, "1"),
          id: 98,
          status: "PENDING",
        },
      ],
    });
    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
      runAttempt: "2",
    });
    const highAlertIndex = service.events.findIndex((event) =>
      event.alertKey === canaryAlertKey(RUN_ID, "2") && event.eventType === "ALERT"
    );
    expect(highAlertIndex).toBeGreaterThan(1);
    expect(service.events.slice(0, highAlertIndex)).toEqual(expect.arrayContaining([
      { alertKey: sourceBindingProbeKey(RUN_ID, "1"), eventType: "RESOLVE" },
      { alertKey: canaryAlertKey(RUN_ID, "1"), eventType: "RESOLVE" },
    ]));
    expect(service.statuses).toEqual(["RESOLVED", "RESOLVED", "RESOLVED"]);
  });

  test("does not let a delayed prior-attempt event satisfy the current identity", async () => {
    const service = canaryService({
      dropAlertCreation: true,
      initialAlerts: [
        {
          alertKey: canaryAlertKey(RUN_ID, "1"),
          id: 11,
          status: "PENDING",
        },
      ],
    });
    await expect(verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
      runAttempt: "2",
    })).rejects.toBeInstanceOf(AggregateError);
    expect(service.events.some((event) =>
      event.alertKey === canaryAlertKey(RUN_ID, "1") && event.eventType === "RESOLVE"
    )).toBe(true);
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
    ).rejects.toThrow("cleanup could not be verified");
    expect(service.events[0]).toEqual({
      alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
      eventType: "ALERT",
    });
    expect(service.events.some((event) => event.eventType === "RESOLVE")).toBe(true);
    expect(new Set(service.events.map((event) => event.alertKey))).toEqual(
      new Set([canaryAlertKey(RUN_ID, RUN_ATTEMPT)]),
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
    ).rejects.toThrow("did not verify canary resolution");
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
    ).rejects.toThrow("did not confirm persisted Postil webhook delivery");
    const observationRequests = service.requests.filter((request) =>
      request.url.startsWith(`${RECEIVER_ORIGIN}/api/webhooks/ilert?`),
    );
    expect(observationRequests.length).toBeGreaterThan(0);
    expect(observationRequests.every((request) =>
      new URL(request.url).searchParams.get("sourceId") === String(SOURCE_ID),
    )).toBe(true);
  });

  test("accepts an exact persisted ACCEPTED canary creation", async () => {
    const service = canaryService({ status: "ACCEPTED" });
    await verifyIlertWebhookCanary({ ...canaryOptions, fetchFn: service.fetchFn });
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("rejects a LOW management result for the HIGH canary", async () => {
    const service = canaryService({ mainPriority: "LOW" });
    await expect(verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
    })).rejects.toThrow("did not confirm persisted Postil webhook delivery");
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("fails when the retained alert ID stays pending despite empty lists", async () => {
    const service = canaryService({
      detailAlwaysPending: true,
      emptyListsAfterResolve: true,
    });
    await expect(verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
    })).rejects.toBeInstanceOf(AggregateError);
    expect(service.requests.some((request) => request.url.endsWith("/alerts/99"))).toBe(true);
  });

  test("uses exact alert detail instead of a stale open-alert listing after RESOLVE", async () => {
    const service = canaryService({ staleOpenReadsAfterResolve: 1 });
    await verifyIlertWebhookCanary({ ...canaryOptions, fetchFn: service.fetchFn });
    expect(service.events.filter((event) => event.eventType === "RESOLVE")).toHaveLength(1);
    expect(service.requests.some((request) => request.url.endsWith("/alerts/99"))).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("a cleaned handoff makes the normal finalizer an idempotent success", async () => {
    const service = canaryService();
    await verifyIlertWebhookCanary({ ...canaryOptions, fetchFn: service.fetchFn });
    const eventCount = service.events.length;
    await finalizeIlertWebhookCanary({
      ...canaryOptions,
      alertSubmitted: "cleaned",
      fetchFn: service.fetchFn,
    });
    expect(service.events).toHaveLength(eventCount);
  });

  test("retries a stale open-state read after an accepted RESOLVE", async () => {
    const service = canaryService({ existing: true, staleOpenReadsAfterResolve: 2 });
    await finalizeIlertWebhookCanary({ ...finalizerOptions(), fetchFn: service.fetchFn });
    expect(service.events.filter((event) =>
      event.alertKey === canaryAlertKey(RUN_ID, RUN_ATTEMPT) && event.eventType === "RESOLVE"
    ).length).toBeGreaterThanOrEqual(2);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("finalizer resolves both deterministic keys before asynchronous discovery", async () => {
    const service = canaryService({
      existing: true,
      deferredListings: 2,
      staleOpenReadsAfterResolve: 2,
      status: "PENDING",
    });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    });
    expect(service.events).toEqual(expect.arrayContaining([
      { alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT), eventType: "RESOLVE" },
      { alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT), eventType: "RESOLVE" },
    ]));
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  for (const alertSubmitted of ["true", "unknown"] as const) {
    test(`${alertSubmitted} finalizer finds a deterministic alert that appears after 31 seconds`, async () => {
      const service = canaryService({
        deferredListings: 8,
        existing: true,
        staleOpenReadsAfterResolve: 2,
      });
      await finalizeIlertWebhookCanary({
        ...finalizerOptions(),
        alertSubmitted,
        fetchFn: service.fetchFn,
      });
      expect(service.events.filter((event) => event.eventType === "RESOLVE").length).toBeGreaterThan(4);
      expect(service.statuses).toEqual(["RESOLVED"]);
    });
  }

  test("finalizer discovers a wrong-source binding probe globally", async () => {
    const events: Array<{ alertKey: string; eventType: string }> = [];
    const requests: Request[] = [];
    let globalReads = 0;
    let status: "PENDING" | "RESOLVED" = "PENDING";
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.url.endsWith(`/alert-sources/${SOURCE_ID}`)) return Response.json(SOURCE);
      if (request.url.endsWith("/events")) {
        const event = await request.json() as { alertKey: string; eventType: string };
        events.push(event);
        if (
          event.alertKey === sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT) &&
          event.eventType === "RESOLVE"
        ) {
          status = "RESOLVED";
        }
        return new Response(null, { status: 202 });
      }
      if (request.url.endsWith("/alerts/99")) {
        return Response.json({
          alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT),
          alertSource: { id: SOURCE_ID + 1 },
          id: 99,
          priority: "LOW",
          status,
        });
      }
      if (request.url.includes("/alerts?")) {
        const query = new URL(request.url).searchParams;
        if (!query.has("sources") && globalReads++ === 0) {
          return Response.json([{
            alertKey: sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT),
            alertSource: { id: SOURCE_ID + 1 },
            id: 99,
            priority: "LOW",
            status: "PENDING",
          }]);
        }
        return Response.json([]);
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    await finalizeIlertWebhookCanary({ ...finalizerOptions(), fetchFn });
    expect(requests.some((request) =>
      request.url.includes("/alerts?") && !new URL(request.url).searchParams.has("sources"),
    )).toBe(true);
    expect(events.some((event) => event.alertKey === sourceBindingProbeKey(RUN_ID, RUN_ATTEMPT))).toBe(true);
  });

  test("management listing failure leaves cleanup required for the attempt key", async () => {
    const service = canaryService({
      existing: true,
      failAlertListings: 3,
      staleOpenReadsAfterResolve: 2,
      status: "PENDING",
    });
    await expect(
      verifyIlertWebhookCanary({ ...canaryOptions, fetchFn: service.fetchFn }),
    ).rejects.toThrow("cleanup could not be verified");
    await finalizeIlertWebhookCanary({ ...finalizerOptions(), fetchFn: service.fetchFn });
    expect(service.events.some((event) => event.eventType === "RESOLVE")).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED", "RESOLVED"]);
  });

  test("unknown finalizer accepts stable no-open evidence only after full discovery", async () => {
    const service = canaryService();
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    });
    expect(service.alertListRequests).toBeGreaterThanOrEqual(74);
  });

  test("continues the finalizer after repeated management 503 responses", async () => {
    const service = canaryService({
      existing: true,
      failAlertListings: 6,
      status: "PENDING",
    });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    });
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("finds a terminal late alert and resolves its retained ID in reserve", async () => {
    const service = canaryService({ lateAlertAtListing: 73 });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    });
    expect(service.statuses).toEqual(["RESOLVED"]);
    expect(service.requests.some((request) => request.url.endsWith("/alerts/199"))).toBe(true);
  });

  test("accounts for an already resolved accepted current alert through all-state lookup", async () => {
    const service = canaryService({ existing: true, status: "RESOLVED" });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      alertSubmitted: "true",
      fetchFn: service.fetchFn,
    });
    const boundedLookup = service.requests.find((request) => {
      if (!request.url.includes("/alerts?")) return false;
      const query = new URL(request.url).searchParams;
      return query.has("from") && query.has("until") && !query.has("states");
    });
    expect(boundedLookup).toBeDefined();
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("does not enumerate 1,100 resolved alerts while checking deterministic open keys", async () => {
    const requests: Request[] = [];
    const historical = Array.from({ length: 1_100 }, (_, index) => ({
      alertKey: `historical-${index}`,
      id: index + 1,
      status: "RESOLVED",
    }));
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith(`/alert-sources/${SOURCE_ID}`)) return Response.json(SOURCE);
      if (request.url.endsWith("/events")) return new Response(null, { status: 202 });
      if (request.url.includes("/alerts?")) {
        const query = new URL(request.url).searchParams;
        return Response.json(query.has("states") ? [] : historical);
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    await finalizeIlertWebhookCanary({ ...finalizerOptions(), fetchFn });
    const alertQueries = requests.filter((request) => request.url.includes("/alerts?"));
    expect(alertQueries.length).toBeGreaterThan(8);
    expect(alertQueries.every((request) => new URL(request.url).searchParams.has("states"))).toBe(true);
  });

  test("finalizer CLI is cleanup-only and never reads or mutates alert actions", async () => {
    const service = canaryService({ existing: true, staleOpenReadsAfterResolve: 2, status: "PENDING" });
    await runCli({
      args: ["--finalize-canary"],
      env: cliEnvironment({ POSTIL_ILERT_RECEIVER_ORIGIN: "not-a-url", POSTIL_ILERT_WEBHOOK_SECRET: "short" }),
      fetchFn: service.fetchFn,
      ...finalizerTiming(),
      log: () => undefined,
    });
    expect(service.requests.some((request) => request.url.includes("/alert-actions"))).toBe(false);
    expect(service.events.some((event) => event.eventType === "ALERT")).toBe(false);
    expect(service.events.some((event) => event.eventType === "RESOLVE")).toBe(true);
  });

  test("cleaned finalizer CLI requires no credential or run configuration", async () => {
    let accessedNetwork = false;
    await runCli({
      args: ["--finalize-canary"],
      env: { POSTIL_ILERT_CANARY_ALERT_SUBMITTED: "cleaned" },
      fetchFn: async () => {
        accessedNetwork = true;
        throw new Error("network access is forbidden");
      },
      log: () => undefined,
    });
    expect(accessedNetwork).toBe(false);
  });

  test("rejects live reconciliation without a recoverable run identity before network access", async () => {
    await expect(runCli({
      args: [],
      env: {},
      fetchFn: async () => { throw new Error("network access is forbidden"); },
      log: () => undefined,
    })).rejects.toThrow("live reconciliation requires --canary");
  });
});

function cliEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ILERT_API_KEY: API_KEY,
    ILERT_INTEGRATION_KEY: INTEGRATION_KEY,
    POSTIL_ILERT_ALERT_SOURCE_ID: String(SOURCE_ID),
    POSTIL_ILERT_CANARY_RUN_ATTEMPT: RUN_ATTEMPT,
    POSTIL_ILERT_CANARY_RUN_ID: RUN_ID,
    POSTIL_ILERT_CANARY_STARTED_AT: new Date(0).toISOString(),
    POSTIL_ILERT_RECEIVER_ORIGIN: RECEIVER_ORIGIN,
    POSTIL_ILERT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides,
  };
}

function finalizerTiming(): { now: () => number; sleep: (milliseconds: number) => Promise<void> } {
  let currentTime = 0;
  return {
    now: () => currentTime,
    sleep: async (milliseconds) => { currentTime += milliseconds; },
  };
}

function finalizerOptions() {
  return {
    ...canaryOptions,
    ...finalizerTiming(),
    startedAt: new Date(0).toISOString(),
  };
}

function canaryService(options: {
  deferredListings?: number;
  detailPendingReads?: number;
  detailAlwaysPending?: boolean;
  dropAlertCreation?: boolean;
  dropResolvedReceiverEvent?: boolean;
  emptyListsAfterResolve?: boolean;
  existing?: boolean;
  failAlertListings?: number;
  initialAlerts?: Array<{
    alertKey?: string;
    id: number;
    priority?: "HIGH" | "LOW";
    sourceId?: number;
    status: "PENDING" | "ACCEPTED" | "RESOLVED";
  }>;
  lateAlertAtListing?: number;
  managementFailsAfterAlert?: boolean;
  mainPriority?: "HIGH" | "LOW";
  observedSourceId?: number;
  receiverObservationFailures?: number;
  resolveRequestFailures?: number;
  sourceIntegrationType?: string;
  staleOpenReadsAfterResolve?: number;
  status?: "PENDING" | "ACCEPTED" | "RESOLVED";
} = {}) {
  const events: Array<{ alertKey: string; eventType: string }> = [];
  const requests: Request[] = [];
  const alerts: Array<{
    alertKey: string;
    createdReceived: boolean;
    id: number;
    priority: "HIGH" | "LOW";
    resolvedReceived: boolean;
    sourceId: number;
    status: "PENDING" | "ACCEPTED" | "RESOLVED";
  }> = options.initialAlerts
    ? options.initialAlerts.map((alert) => ({
        alertKey: alert.alertKey ?? canaryAlertKey(RUN_ID, RUN_ATTEMPT),
        createdReceived: true,
        id: alert.id,
        priority: alert.priority ?? "HIGH",
        resolvedReceived: alert.status === "RESOLVED",
        sourceId: alert.sourceId ?? SOURCE_ID,
        status: alert.status,
      }))
    : options.existing
    ? [{
        alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
        createdReceived: true,
        id: 98,
        priority: options.mainPriority ?? "HIGH",
        resolvedReceived: options.status === "RESOLVED",
        sourceId: SOURCE_ID,
        status: options.status ?? "PENDING",
      }]
    : [];
  let alertSent = false;
  let alertListRequests = 0;
  let failAlertListings = options.failAlertListings ?? 0;
  let detailPendingReads = options.detailPendingReads ?? 0;
  let lateAlertAdded = false;
  let receiverObservationFailures = options.receiverObservationFailures ?? 0;
  let receiverObservationRequests = 0;
  let resolveRequestFailures = options.resolveRequestFailures ?? 0;
  let staleOpenReadsAfterResolve = options.staleOpenReadsAfterResolve ?? 0;

  const fetchFn: Fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (request.url.endsWith(`/alert-sources/${SOURCE_ID}`)) {
      return Response.json({
        ...SOURCE,
        integrationType: options.sourceIntegrationType ?? SOURCE.integrationType,
      });
    }
    if (request.method === "POST" && request.url.endsWith("/events")) {
      const body = await request.json() as {
        alertKey: string;
        eventType: string;
        priority?: "HIGH" | "LOW";
      };
      events.push({ alertKey: body.alertKey, eventType: body.eventType });
      if (body.eventType === "ALERT" && !options.dropAlertCreation) {
        alertSent = true;
        const id = alerts.length === 0
          ? 99
          : Math.max(...alerts.map((alert) => alert.id)) + 1;
        alerts.push({
          alertKey: body.alertKey,
          createdReceived: true,
          id,
          priority: options.mainPriority ?? body.priority ?? "HIGH",
          resolvedReceived: false,
          sourceId: SOURCE_ID,
          status: options.status === "ACCEPTED" ? "ACCEPTED" : "PENDING",
        });
      }
      if (body.eventType === "RESOLVE") {
        if (resolveRequestFailures > 0) {
          resolveRequestFailures -= 1;
          return new Response(null, { status: 503 });
        }
        for (const alert of alerts.filter((item) =>
          item.alertKey === body.alertKey && item.status !== "RESOLVED"
        )) {
          alert.status = "RESOLVED";
          if (!options.dropResolvedReceiverEvent) alert.resolvedReceived = true;
        }
      }
      return new Response(null, { status: 202 });
    }
    const detailId = /\/alerts\/([1-9][0-9]*)$/u.exec(new URL(request.url).pathname)?.[1];
    if (detailId) {
      const alert = alerts.find((item) => String(item.id) === detailId);
      if (!alert) return Response.json({ error: "not found" }, { status: 404 });
      const status = options.detailAlwaysPending
        ? "PENDING"
        : detailPendingReads > 0
        ? (detailPendingReads -= 1, "PENDING" as const)
        : alert.status;
      return Response.json({
        alertKey: alert.alertKey,
        alertSource: { id: alert.sourceId },
        id: alert.id,
        priority: alert.priority,
        status,
      });
    }
    if (request.url.includes("/alerts?")) {
      alertListRequests += 1;
      if (failAlertListings > 0) {
        failAlertListings -= 1;
        return new Response(null, { status: 503 });
      }
      if (options.managementFailsAfterAlert && alertSent) {
        return new Response(null, { status: 503 });
      }
      if (alertListRequests <= (options.deferredListings ?? 0)) {
        return Response.json([]);
      }
      if (
        options.lateAlertAtListing === alertListRequests &&
        !lateAlertAdded
      ) {
        lateAlertAdded = true;
        alerts.push({
          alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
          createdReceived: true,
          id: 199,
          priority: "HIGH",
          resolvedReceived: false,
          sourceId: SOURCE_ID,
          status: "PENDING",
        });
      }
      const stale = staleOpenReadsAfterResolve > 0;
      if (stale) staleOpenReadsAfterResolve -= 1;
      const query = new URL(request.url).searchParams;
      const states = query.getAll("states");
      const source = query.get("sources");
      return Response.json(alerts.flatMap((alert) => {
        const status = stale && alert.status === "RESOLVED" ? "PENDING" : alert.status;
        if (options.emptyListsAfterResolve && alert.status === "RESOLVED") return [];
        if (source && source !== String(alert.sourceId)) return [];
        if (states.length > 0 && !states.includes(status)) return [];
        return [{
          alertKey: alert.alertKey,
          alertSource: { id: alert.sourceId },
          id: alert.id,
          priority: alert.priority,
          status,
        }];
      }));
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
  let probe: { key: string; status: "PENDING" | "RESOLVED" } | undefined;
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (request.method === "POST" && request.url.endsWith("/events")) {
      const body = await request.json() as { alertKey: string; eventType: string };
      if (body.eventType === "ALERT") probe = { key: body.alertKey, status: "PENDING" };
      if (body.eventType === "RESOLVE" && probe?.key === body.alertKey) {
        probe.status = "RESOLVED";
      }
      return new Response(null, { status: 202 });
    }
    if (request.url.endsWith("/alerts/991") && probe) {
      return Response.json({
        alertKey: probe.key,
        alertSource: { id: SOURCE_ID },
        id: 991,
        priority: "LOW",
        status: probe.status,
      });
    }
    if (request.url.includes("/alerts?")) {
      return Response.json(probe ? [{
        alertKey: probe.key,
        alertSource: { id: SOURCE_ID },
        id: 991,
        priority: "LOW",
        status: probe.status,
      }] : []);
    }
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
}
