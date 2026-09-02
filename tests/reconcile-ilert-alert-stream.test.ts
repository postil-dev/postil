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
    ).rejects.toThrow("integration binding validation failed");
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toMatch(/^\/api\/alert-sources\/[^/]+$/u);
    expect(requests[0]!.method).toBe("GET");
  });

  test("rejects a mismatched management binding before action mutation or Event API use", async () => {
    const requests: Request[] = [];
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({ ...SOURCE, id: SOURCE_ID + 1 });
    };
    await expect(reconcileIlertAlertAction({ ...reconcileOptions, fetchFn }))
      .rejects.toThrow("integration binding validation failed");
    expect(requests.filter((request) =>
      request.url.endsWith("/events") ||
      (request.url.includes("/alert-actions") && request.method !== "GET")
    )).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  test("redacts a sensitive binding failure and emits no Event API mutation", async () => {
    const integrationKey = "sensitive-integration-key";
    const apiKey = "sensitive-management-key";
    const requests: Request[] = [];
    const logs: string[] = [];
    let error: unknown;
    try {
      await runCli({
        args: ["--dry-run"],
        env: cliEnvironment({ ILERT_API_KEY: apiKey, ILERT_INTEGRATION_KEY: integrationKey }),
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          throw new Error(`request failed for ${request.url} with Bearer ${apiKey}`);
        },
        log: (message) => logs.push(message),
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toBe("Error: iLert integration binding validation failed");
    expect(String(error)).not.toContain(integrationKey);
    expect(String(error)).not.toContain(apiKey);
    expect(logs.join("\n")).not.toContain(integrationKey);
    expect(logs.join("\n")).not.toContain(apiKey);
    expect(requests.every((request) => !request.url.endsWith("/events"))).toBe(true);
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

  test("runs the receiver preflight without Event API mutation for an equivalent action", async () => {
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
    expect(requests.filter((request) => request.url.endsWith("/events"))).toHaveLength(0);
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

  test("fails closed for a renamed action at the receiver endpoint with an older credential", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const oldCredential = "older-webhook-credential-that-must-not-leak";
    const renamed = {
      ...desired,
      alertSources: [{ id: SOURCE_ID + 1 }],
      id: "72",
      name: "Legacy operator webhook",
      params: {
        ...(desired.params as Record<string, unknown>),
        webhookUrl: `https://postil-ilert:${oldCredential}@postil.example/api/webhooks/ilert`,
      },
    };
    let error: unknown;
    try {
      await reconcileIlertAlertAction({
        ...reconcileOptions,
        dryRun: true,
        fetchFn: queuedFetch([], [
          Response.json(SOURCE),
          Response.json([{
            id: "72",
            name: renamed.name,
            params: renamed.params,
          }]),
          Response.json(renamed),
        ]),
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("conflicting Postil alert action");
    expect(String(error)).not.toContain(oldCredential);
  });

  test("adopts one equivalent action after an ambiguous committed POST without retrying", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    let created = false;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
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

  test("fails closed when ambiguous action creation finds an equivalent and a conflicting reserved candidate", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const oldCredential = "older-webhook-credential-that-must-not-leak";
    let created = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (request.url === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (request.method === "POST" && request.url.includes("/alert-actions")) {
          created = true;
          throw new Error("connection reset after commit");
        }
        if (request.url.includes("/alert-actions")) {
          if (!created) return Response.json([]);
          if (request.url.includes("include=conditions")) {
            const id = new URL(request.url).pathname.split("/").at(-1);
            return Response.json(id === "73"
              ? { ...desired, id: "73" }
              : {
                  ...desired,
                  alertSources: [{ id: SOURCE_ID + 1 }],
                  id: "74",
                  name: "Legacy operator webhook",
                  params: {
                    ...(desired.params as Record<string, unknown>),
                    webhookUrl: `https://postil-ilert:${oldCredential}@postil.example/api/webhooks/ilert`,
                  },
                });
          }
          return Response.json([
            { id: "73", name: desired.name },
            {
              id: "74",
              name: "Legacy operator webhook",
              params: {
                webhookUrl: `https://postil-ilert:${oldCredential}@postil.example/api/webhooks/ilert`,
              },
            },
          ]);
        }
        throw new Error("unexpected request");
      },
    })).rejects.toThrow("conflicting Postil alert action");
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
    expect(requests.filter((request) => request.url.endsWith("/events"))).toHaveLength(0);
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
        Response.json([{ id: "71", name: desired.name }]),
        Response.json({ ...desired, id: "71" }),
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

  test("fails closed after creation when the global inventory finds a concurrent reserved candidate", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const oldCredential = "older-webhook-credential-that-must-not-leak";
    for (const conflictingSummary of [
      { id: "74", name: desired.name },
      {
        id: "74",
        name: "Legacy operator webhook",
        params: {
          webhookUrl: `https://postil-ilert:${oldCredential}@postil.example/api/webhooks/ilert`,
        },
      },
    ]) {
      let inventoryScans = 0;
      const requests: Request[] = [];
      await expect(reconcileIlertAlertAction({
        ...reconcileOptions,
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request.clone());
          if (new URL(request.url).pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
          if (request.url === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
          if (request.method === "POST" && request.url.includes("/alert-actions")) {
            return Response.json({ id: "73" });
          }
          if (request.url.includes("/alert-actions?")) {
            inventoryScans += 1;
            return Response.json(inventoryScans === 1
              ? []
              : [{ id: "73", name: desired.name }, conflictingSummary]);
          }
          if (request.url.includes("/alert-actions/")) {
            const id = new URL(request.url).pathname.split("/").at(-1);
            return Response.json(id === "73"
              ? { ...desired, id: "73" }
              : { ...desired, ...conflictingSummary, id: "74" });
          }
          throw new Error(`unexpected request: ${request.method} ${request.url}`);
        },
      })).rejects.toThrow("Multiple Postil webhook alert actions exist");
      expect(requests.filter((request) =>
        request.method === "POST" && request.url.includes("/alert-actions")
      )).toHaveLength(1);
    }
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
        fetchFn: async (input) => new URL(String(input)).pathname.startsWith("/api/alert-sources/")
          ? Response.json(SOURCE)
          : new Response(providerBody, { status: 403 }),
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
    expect(canaryAlertKey(RUN_ID, "50")).toBe(
      "postil-ilert-webhook-canary-12345-50",
    );
  });

  test("accepts attempt 50 as a finalizer sweep ceiling", async () => {
    const service = canaryService();
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
      runAttempt: "1",
      sweepAttempt: "50",
    });
    expect(service.alertListRequests).toBeGreaterThan(0);
  });

  test("attempt 2 pre-cleans attempt 1 main key before its HIGH alert", async () => {
    const service = canaryService({
      initialAlerts: [
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
    expect(highAlertIndex).toBeGreaterThan(-1);
    expect(service.statuses).toEqual(["RESOLVED", "RESOLVED"]);
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
    expect(service.statuses[0]).toBe("RESOLVED");
  });

  test("rejects a non-API source before ALERT", async () => {
    const service = canaryService({ sourceIntegrationType: "GITHUB" });
    await expect(
      verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: service.fetchFn,
      }),
    ).rejects.toThrow("integration binding validation failed");
    expect(service.events).toHaveLength(0);
  });

  test("uses a same-key Event RESOLVE only while the current alert is undiscovered", async () => {
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
    expect(service.requests.filter((request) => request.method === "PUT" && /\/alerts\/[1-9][0-9]*\/resolve$/u.test(new URL(request.url).pathname))).toHaveLength(3);
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

  test("keeps discovery open for a canary report time 16 seconds after a 202", async () => {
    let currentTime = 0;
    const service = canaryService({
      alertReportTime: new Date(16_000).toISOString(),
      alertRetryAfter: "10",
    });
    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    const discoveryWindows = service.requests
      .filter((request) => request.url.includes("/alerts?"))
      .map((request) => new URL(request.url).searchParams);
    expect(Date.parse(discoveryWindows[0]!.get("from")!)).toBe(-5_000);
    const discoveryUntil = discoveryWindows.map((query) => Date.parse(query.get("until")!));
    expect(discoveryUntil).toContain(15_000);
    expect(discoveryUntil.some((until) => until >= 16_000)).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("discovers and resolves the exact canary after a slow successful ALERT response", async () => {
    let currentTime = 0;
    const service = canaryService({ alertReportTime: new Date(0).toISOString() });
    let delayed = false;
    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        const response = await service.fetchFn(input, init);
        if (!delayed && request.method === "POST" && request.url.endsWith("/events")) {
          delayed = true;
          currentTime += 6_000;
        }
        return response;
      },
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    const firstDiscovery = service.requests.find((request) => request.url.includes("/alerts?"));
    expect(Date.parse(new URL(firstDiscovery!.url).searchParams.get("from")!)).toBe(-5_000);
    expect(Date.parse(new URL(firstDiscovery!.url).searchParams.get("until")!)).toBe(11_000);
    expect(service.requests.some((request) => request.url.endsWith("/alerts/99/resolve"))).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("discovers and resolves the exact committed canary after a lost first ALERT response", async () => {
    let currentTime = 0;
    const service = canaryService({
      alertReportTime: new Date(0).toISOString(),
      deduplicateAlertKeys: true,
    });
    let lost = false;
    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        const response = await service.fetchFn(input, init);
        if (!lost && request.method === "POST" && request.url.endsWith("/events")) {
          lost = true;
          currentTime += 8_000;
          throw new Error("connection reset after commit");
        }
        return response;
      },
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    const firstDiscovery = service.requests.find((request) => request.url.includes("/alerts?"));
    expect(Date.parse(new URL(firstDiscovery!.url).searchParams.get("from")!)).toBe(-5_000);
    expect(Date.parse(new URL(firstDiscovery!.url).searchParams.get("until")!)).toBe(13_500);
    expect(service.events.filter((event) => event.eventType === "ALERT")).toHaveLength(2);
    expect(service.requests.some((request) => request.url.endsWith("/alerts/99/resolve"))).toBe(true);
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
    expect(service.requests.some((request) => request.method === "PUT" && request.url.endsWith("/alerts/99/resolve"))).toBe(true);
    expect(service.events.filter((event) => event.eventType === "RESOLVE")).toHaveLength(0);
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
    expect(service.requests.filter((request) => request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")).length).toBeGreaterThanOrEqual(2);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("finalizer resolves a discovered deterministic key by management identity", async () => {
    const service = canaryService({
      existing: true,
      deferredListings: 0,
      staleOpenReadsAfterResolve: 2,
      status: "PENDING",
    });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    });
    expect(service.requests.some((request) => request.method === "PUT" && request.url.endsWith("/alerts/98/resolve"))).toBe(true);
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
      expect(service.requests.some((request) => request.method === "PUT" && /\/alerts\/[1-9][0-9]*\/resolve$/u.test(new URL(request.url).pathname))).toBe(true);
      expect(service.statuses).toEqual(["RESOLVED"]);
    });
  }

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
    expect(service.requests.some((request) => request.method === "PUT" && /\/alerts\/[1-9][0-9]*\/resolve$/u.test(new URL(request.url).pathname))).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED", "RESOLVED"]);
  });

  test("unknown finalizer accepts a same-key Event API RESOLVE only after full discovery", async () => {
    const service = canaryService();
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    });
    expect(service.alertListRequests).toBeGreaterThanOrEqual(36);
    expect(service.events).toEqual([{
      alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
      eventType: "RESOLVE",
    }]);
  });

  test("unknown finalizer fails closed when every Event API RESOLVE is rejected and management stays empty", async () => {
    const service = canaryService({ eventResolveAlwaysFails: true });
    await expect(finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    })).rejects.toThrow("could not account for the accepted current-attempt submission");
    expect(service.events.filter((event) => event.eventType === "RESOLVE").length).toBeGreaterThan(1);
    expect(service.statuses).toEqual([]);
  });

  test("unknown finalizer recovers through a discovered ID when Event API RESOLVEs fail", async () => {
    const service = canaryService({
      deferredListings: 1,
      eventResolveAlwaysFails: true,
      existing: true,
      staleOpenReadsAfterResolve: 2,
    });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    });
    expect(service.events.some((event) => event.eventType === "RESOLVE")).toBe(true);
    expect(service.requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")
    )).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
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

  test("finds a late discovery alert and resolves its retained ID in reserve", async () => {
    const service = canaryService({ lateAlertAtListing: 36 });
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

  test("uses the producer attempt for accepted-current finalizer proof", async () => {
    const service = canaryService({ existing: true, status: "RESOLVED" });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      alertSubmitted: "true",
      fetchFn: service.fetchFn,
      runAttempt: "1",
      sweepAttempt: "2",
    });
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
      if (new URL(request.url).pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
      if (request.url.endsWith("/events")) return new Response(null, { status: 202 });
      if (request.url.includes("/alerts?")) {
        const query = new URL(request.url).searchParams;
        const start = Number(query.get("start-index"));
        return Response.json(historical.slice(start, start + 100));
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    await finalizeIlertWebhookCanary({ ...finalizerOptions(), fetchFn });
    const alertQueries = requests.filter((request) => request.url.includes("/alerts?"));
    expect(alertQueries.length).toBeGreaterThan(8);
    expect(alertQueries.some((request) => new URL(request.url).searchParams.get("start-index") === "1000")).toBe(true);
    expect(alertQueries.every((request) => !new URL(request.url).searchParams.has("states"))).toBe(true);
  });

  for (const status of ["UNKNOWN", undefined] as const) {
    test(`finalizer fails closed when a matching alert has ${status ?? "no"} status`, async () => {
      const service = canaryService({ existing: true, emptyListsAfterResolve: true });
      let alertListings = 0;
      await expect(finalizeIlertWebhookCanary({
        ...finalizerOptions(),
        alertSubmitted: "unknown",
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          if (request.url.includes("/alerts?")) {
            alertListings += 1;
            if (alertListings === 1) return Response.json([]);
            if (alertListings === 2) {
              return Response.json([{
                alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
                alertSource: { id: SOURCE_ID },
                id: 98,
                priority: "HIGH",
                ...(status === undefined ? {} : { status }),
              }]);
            }
          }
          return service.fetchFn(input, init);
        },
      })).rejects.toThrow("invalid status");
      expect(service.events).toEqual([{
        alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
        eventType: "RESOLVE",
      }]);
      expect(service.statuses).toEqual(["RESOLVED"]);
      expect(service.requests.some((request) =>
        request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")
      )).toBe(true);
    });
  }

  for (const status of ["UNKNOWN", undefined] as const) {
    test(`primary and finalizer retain an exact ID after ${status ?? "missing"} detail status`, async () => {
      let primaryDetailRead = false;
      const primary = canaryService();
      await expect(verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          if (!primaryDetailRead && request.url.endsWith("/alerts/99")) {
            primaryDetailRead = true;
            return Response.json({
              alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
              alertSource: { id: SOURCE_ID },
              id: 99,
              priority: "HIGH",
              ...(status === undefined ? {} : { status }),
            });
          }
          return primary.fetchFn(input, init);
        },
      })).rejects.toThrow("invalid status");
      expect(primary.requests.filter((request) =>
        request.method === "PUT" && request.url.endsWith("/alerts/99/resolve")
      ).length).toBeGreaterThanOrEqual(2);

      let finalizerDetailRead = false;
      const finalizer = canaryService({ existing: true });
      await expect(finalizeIlertWebhookCanary({
        ...finalizerOptions(),
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          if (!finalizerDetailRead && request.url.endsWith("/alerts/98")) {
            finalizerDetailRead = true;
            return Response.json({
              alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
              alertSource: { id: SOURCE_ID },
              id: 98,
              priority: "HIGH",
              ...(status === undefined ? {} : { status }),
            });
          }
          return finalizer.fetchFn(input, init);
        },
      })).rejects.toThrow("invalid status");
      expect(finalizer.requests.filter((request) =>
        request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")
      ).length).toBeGreaterThanOrEqual(2);
    });

    test(`matching list ${status ?? "missing"} status retains the primary exact ID for cleanup`, async () => {
      let invalidListingReturned = false;
      const service = canaryService();
      await expect(verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          if (!invalidListingReturned && request.url.includes("/alerts?")) {
            invalidListingReturned = true;
            return Response.json([{
              alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
              alertSource: { id: SOURCE_ID },
              id: 99,
              priority: "HIGH",
              ...(status === undefined ? {} : { status }),
            }]);
          }
          return service.fetchFn(input, init);
        },
      })).rejects.toThrow("invalid status");
      expect(service.requests.some((request) =>
        request.method === "PUT" && request.url.endsWith("/alerts/99/resolve")
      )).toBe(true);
      expect(service.events.filter((event) => event.eventType === "RESOLVE")).toEqual([]);
    });
  }

  test("fails closed after a discovery-deadline pagination failure while resolving IDs from prior pages", async () => {
    const requests: Request[] = [];
    let currentTime = 0;
    let resolved = false;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
      if (request.method === "PUT" && url.pathname === "/api/alerts/98/resolve") {
        resolved = true;
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/api/alerts/98") {
        return Response.json({
          alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
          alertSource: { id: SOURCE_ID },
          id: 98,
          priority: "HIGH",
          status: resolved ? "RESOLVED" : "PENDING",
        });
      }
      if (url.pathname === "/api/alerts") {
        const start = Number(url.searchParams.get("start-index"));
        if (start === 0) {
          return Response.json([
            {
              alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
              alertSource: { id: SOURCE_ID },
              id: 98,
              priority: "HIGH",
              status: "PENDING",
            },
            ...Array.from({ length: 99 }, (_, index) => ({
              alertKey: `unrelated-${index}`,
              alertSource: { id: SOURCE_ID },
              id: index + 100,
              priority: "HIGH",
              status: "PENDING",
            })),
          ]);
        }
        if (start === 100) {
          currentTime = 360_000;
          return Response.json(Array.from({ length: 100 }, (_, index) => ({
            alertKey: `unrelated-page-two-${index}`,
            alertSource: { id: SOURCE_ID },
            id: index + 200,
            priority: "HIGH",
            status: "PENDING",
          })));
        }
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };

    await expect(finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    })).rejects.toThrow("inventory was incomplete");
    const alertPages = requests.filter((request) => new URL(request.url).pathname === "/api/alerts");
    expect(alertPages.map((request) => new URL(request.url).searchParams.get("start-index")))
      .toEqual(["0", "100"]);
    expect(requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")
    )).toBe(true);
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
    expect(service.requests.some((request) => request.method === "PUT" && /\/alerts\/[1-9][0-9]*\/resolve$/u.test(new URL(request.url).pathname))).toBe(true);
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
  alertReportTime?: string;
  alertRetryAfter?: string;
  deduplicateAlertKeys?: boolean;
  deferredListings?: number;
  detailPendingReads?: number;
  detailAlwaysPending?: boolean;
  dropAlertCreation?: boolean;
  dropResolvedReceiverEvent?: boolean;
  emptyListsAfterResolve?: boolean;
  eventResolveAlwaysFails?: boolean;
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
    reportTime?: string;
    resolvedReceived: boolean;
    sourceId: number;
    status: "PENDING" | "ACCEPTED" | "RESOLVED";
  }> = options.initialAlerts
    ? options.initialAlerts.map((alert) => ({
        alertKey: alert.alertKey ?? canaryAlertKey(RUN_ID, RUN_ATTEMPT),
        createdReceived: true,
        id: alert.id,
        priority: alert.priority ?? "HIGH",
        reportTime: undefined,
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
        reportTime: undefined,
        resolvedReceived: options.status === "RESOLVED",
        sourceId: SOURCE_ID,
        status: options.status ?? "PENDING",
      }]
    : [];
  let alertSent = false;
  let alertRetryPending = options.alertRetryAfter !== undefined;
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
    if (new URL(request.url).pathname.startsWith("/api/alert-sources/")) {
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
      if (body.eventType === "ALERT" && alertRetryPending) {
        alertRetryPending = false;
        return new Response(null, {
          status: 429,
          headers: { "retry-after": options.alertRetryAfter! },
        });
      }
      if (
        body.eventType === "ALERT" &&
        !options.dropAlertCreation &&
        (!options.deduplicateAlertKeys || !alerts.some((alert) => alert.alertKey === body.alertKey))
      ) {
        alertSent = true;
        const id = alerts.length === 0
          ? 99
          : Math.max(...alerts.map((alert) => alert.id)) + 1;
        alerts.push({
          alertKey: body.alertKey,
          createdReceived: true,
          id,
          priority: options.mainPriority ?? body.priority ?? "HIGH",
          reportTime: options.alertReportTime,
          resolvedReceived: false,
          sourceId: SOURCE_ID,
          status: options.status === "ACCEPTED" ? "ACCEPTED" : "PENDING",
        });
      }
      if (body.eventType === "RESOLVE") {
        if (options.eventResolveAlwaysFails) return new Response(null, { status: 503 });
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
    const resolveId = /\/alerts\/([1-9][0-9]*)\/resolve$/u.exec(new URL(request.url).pathname)?.[1];
    if (request.method === "PUT" && resolveId) {
      const alert = alerts.find((item) => String(item.id) === resolveId);
      if (!alert) return new Response(null, { status: 404 });
      if (resolveRequestFailures > 0) {
        resolveRequestFailures -= 1;
        return new Response(null, { status: 503 });
      }
      alert.status = "RESOLVED";
      if (!options.dropResolvedReceiverEvent) alert.resolvedReceived = true;
      return new Response(null, { status: 200 });
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
          reportTime: undefined,
          resolvedReceived: false,
          sourceId: SOURCE_ID,
          status: "PENDING",
        });
      }
      const stale = staleOpenReadsAfterResolve > 0;
      if (stale) staleOpenReadsAfterResolve -= 1;
      const query = new URL(request.url).searchParams;
      const states = query.getAll("states");
      const from = query.get("from");
      const source = query.get("sources");
      const until = query.get("until");
      return Response.json(alerts.flatMap((alert) => {
        const status = stale && alert.status === "RESOLVED" ? "PENDING" : alert.status;
        if (options.emptyListsAfterResolve && alert.status === "RESOLVED") return [];
        if (alert.reportTime && ((from && alert.reportTime < from) || (until && alert.reportTime > until))) return [];
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
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
}
