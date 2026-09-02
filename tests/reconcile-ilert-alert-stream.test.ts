import { describe, expect, test } from "bun:test";

import {
  ALERT_TRIGGER_TYPES,
  canaryAlertKey,
  desiredAlertAction,
  equivalentAlertAction,
  finalizeIlertAlertStreamCanary,
  type Fetch,
  reconcileIlertAlertAction,
  verifyIlertAlertStreamCanary,
} from "../scripts/reconcile-ilert-alert-stream";

const API_KEY = "test-api-key";
const SOURCE_ID = 42;
const WEBHOOK_SECRET = "test-webhook-secret-with-at-least-32-bytes";
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

describe("iLert alert-stream reconciliation", () => {
  test("builds the bounded automatic webhook action with URL-encoded credentials", () => {
    const secret = "test webhook:/?#%";
    const desired = desiredAlertAction(SOURCE, secret);
    expect(desired).toMatchObject({
      alertSources: [SOURCE],
      connectorType: "webhook",
      name: "Postil operator alert stream",
      triggerMode: "AUTOMATIC",
      triggerTypes: [...ALERT_TRIGGER_TYPES],
      params: {
        webhookUrl:
          "https://postil-ilert:test%20webhook%3A%2F%3F%23%25@postil.dev/api/webhooks/ilert",
      },
    });
    expect((desired.params as Record<string, unknown>).headers).toBeUndefined();
  });

  test("compares the generated credential URL and rejects unsupported headers", () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET);
    const actual = structuredClone(desired) as Record<string, unknown>;
    actual.id = "42";
    actual.triggerTypes = [...ALERT_TRIGGER_TYPES].reverse();
    expect(equivalentAlertAction(actual, desired)).toBe(true);
    (actual.params as Record<string, unknown>).headers = [];
    expect(equivalentAlertAction(actual, desired)).toBe(true);
    (actual.params as Record<string, unknown>).headers = [
      { key: "Authorization", value: "unsupported" },
    ];
    expect(equivalentAlertAction(actual, desired)).toBe(false);
  });

  test("dry-run reports create without mutating", async () => {
    const requests: Request[] = [];
    const result = await reconcileIlertAlertAction({
      apiKey: API_KEY,
      sourceId: SOURCE_ID,
      webhookSecret: WEBHOOK_SECRET,
      dryRun: true,
      fetchFn: fakeFetch(requests, [Response.json(SOURCE), Response.json([])]),
    });
    expect(result).toEqual({ actionId: null, operation: "create" });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.method).toBe("GET");
  });

  test("rejects an incomplete source instead of sending a lossy relation", async () => {
    await expect(
      reconcileIlertAlertAction({
        apiKey: API_KEY,
        sourceId: SOURCE_ID,
        webhookSecret: WEBHOOK_SECRET,
        dryRun: true,
        fetchFn: fakeFetch([], [
          Response.json({ id: SOURCE_ID, name: SOURCE.name }),
        ]),
      }),
    ).rejects.toThrow("invalid alert source");
  });

  test("checks every action page before planning a create", async () => {
    const requests: Request[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(index + 1),
    }));
    const responses = [
      Response.json(SOURCE),
      Response.json(firstPage),
      Response.json([]),
      ...firstPage.map(({ id }) =>
        Response.json({
          id,
          name: `Unrelated action ${id}`,
          connectorType: "webhook",
          alertSources: [{ id: SOURCE_ID + 1 }],
          params: { webhookUrl: `https://example.test/hooks/${id}` },
        }),
      ),
    ];
    const result = await reconcileIlertAlertAction({
      apiKey: API_KEY,
      sourceId: SOURCE_ID,
      webhookSecret: WEBHOOK_SECRET,
      dryRun: true,
      fetchFn: fakeFetch(requests, responses),
    });
    expect(result).toEqual({ actionId: null, operation: "create" });
    expect(requests[1]!.url).toContain("start-index=0");
    expect(requests[2]!.url).toContain("start-index=100");
    expect(requests).toHaveLength(103);
  });

  test("accepts exactly 1,100 full action records after probing the next page", async () => {
    const requests: Request[] = [];
    const actions = Array.from({ length: 1_100 }, (_, index) => ({
      id: String(index + 1),
    }));
    const responses = [
      Response.json(SOURCE),
      ...Array.from({ length: 11 }, (_, page) =>
        Response.json(actions.slice(page * 100, page * 100 + 100)),
      ),
      Response.json([]),
      ...actions.map(({ id }) =>
        Response.json({
          id,
          name: `Unrelated action ${id}`,
          connectorType: "webhook",
          alertSources: [{ id: SOURCE_ID + 1 }],
          params: { webhookUrl: `https://example.test/hooks/${id}` },
        }),
      ),
    ];
    await expect(
      reconcileIlertAlertAction({
        apiKey: API_KEY,
        sourceId: SOURCE_ID,
        webhookSecret: WEBHOOK_SECRET,
        dryRun: true,
        fetchFn: fakeFetch(requests, responses),
      }),
    ).resolves.toEqual({ actionId: null, operation: "create" });
    expect(requests[12]!.url).toContain("start-index=1100");
  });

  test("creates a missing action without exposing credentials", async () => {
    const requests: Request[] = [];
    const result = await reconcileIlertAlertAction({
      apiKey: API_KEY,
      sourceId: SOURCE_ID,
      webhookSecret: WEBHOOK_SECRET,
      fetchFn: fakeFetch(requests, [
        Response.json(SOURCE),
        Response.json([]),
        Response.json({ id: "71" }),
        Response.json({ ...desiredAlertAction(SOURCE, WEBHOOK_SECRET), id: "71" }),
      ]),
    });
    expect(result).toEqual({ actionId: "71", operation: "create" });
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "GET",
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${API_KEY}`,
      `Bearer ${API_KEY}`,
      `Bearer ${API_KEY}`,
      `Bearer ${API_KEY}`,
    ]);
  });

  test("updates one drifted action and leaves an equivalent action unchanged", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET);
    const drifted = { ...desired, id: "72", triggerMode: "MANUAL" };
    const updateRequests: Request[] = [];
    const updated = await reconcileIlertAlertAction({
      apiKey: API_KEY,
      sourceId: SOURCE_ID,
      webhookSecret: WEBHOOK_SECRET,
      fetchFn: fakeFetch(updateRequests, [
        Response.json(SOURCE),
        Response.json([{ id: "72" }]),
        Response.json(drifted),
        Response.json({ ...desired, id: "action-72" }),
        Response.json({ ...desired, id: "action-72" }),
      ]),
    });
    expect(updated).toEqual({ actionId: "action-72", operation: "update" });
    expect(updateRequests[3]!.method).toBe("PUT");

    const unchangedRequests: Request[] = [];
    const unchanged = await reconcileIlertAlertAction({
      apiKey: API_KEY,
      sourceId: SOURCE_ID,
      webhookSecret: WEBHOOK_SECRET,
      fetchFn: fakeFetch(unchangedRequests, [
        Response.json(SOURCE),
        Response.json([{ id: "72" }]),
        Response.json({ ...desired, id: "72" }),
      ]),
    });
    expect(unchanged).toEqual({ actionId: "72", operation: "unchanged" });
    expect(unchangedRequests).toHaveLength(3);
  });

  test("fails closed on duplicate candidates and does not delete either", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET);
    const requests: Request[] = [];
    await expect(
      reconcileIlertAlertAction({
        apiKey: API_KEY,
        sourceId: SOURCE_ID,
        webhookSecret: WEBHOOK_SECRET,
        fetchFn: fakeFetch(requests, [
          Response.json(SOURCE),
          Response.json([
            { id: "72" },
            { id: "73" },
          ]),
          Response.json({ ...desired, id: "72" }),
          Response.json({ ...desired, id: "73" }),
        ]),
      }),
    ).rejects.toThrow("Multiple Postil webhook alert actions exist");
    expect(requests).toHaveLength(4);
  });

  test("reports only an HTTP status when the provider rejects a request", async () => {
    const providerBody = "provider response containing credential material";
    await expect(
      reconcileIlertAlertAction({
        apiKey: API_KEY,
        sourceId: SOURCE_ID,
        webhookSecret: WEBHOOK_SECRET,
        fetchFn: async () => new Response(providerBody, { status: 403 }),
      }),
    ).rejects.toThrow("HTTP 403");
    try {
      await reconcileIlertAlertAction({
        apiKey: API_KEY,
        sourceId: SOURCE_ID,
        webhookSecret: WEBHOOK_SECRET,
        fetchFn: async () => new Response(providerBody, { status: 403 }),
      });
    } catch (error) {
      expect(String(error)).not.toContain(providerBody);
    }
  });

  test("uses a stable canary key, pre-cleans it, and stabilizes resolution", async () => {
    const service = canaryService();
    await verifyIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    expect(canaryAlertKey()).toBe("postil-operator-alert-stream-canary");
    expect(canaryAlertKey()).not.toBe("postil-production-monitor");
    expect(service.events.map((event) => event.eventType)).toEqual([
      "RESOLVE",
      "RESOLVE",
      "RESOLVE",
      "RESOLVE",
      "ALERT",
      "RESOLVE",
      "RESOLVE",
      "RESOLVE",
      "RESOLVE",
    ]);
    expect(service.events.every((event) => event.alertKey === canaryAlertKey())).toBe(true);
  });

  test("finalizer reconstructs, resolves, and verifies the stable canary key", async () => {
    const service = canaryService({ existing: true, status: "PENDING", deliveries: 1 });
    await finalizeIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    expect(service.events).toHaveLength(4);
    expect(service.events.every((event) => event.alertKey === canaryAlertKey())).toBe(true);
    expect(service.status).toBe("RESOLVED");
  });

  test("closes an ALERT accepted after earlier same-key RESOLVE events", async () => {
    const service = canaryService({ deferAlertAcceptance: true });
    await verifyIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    const alertIndex = service.events.findIndex((event) => event.eventType === "ALERT");
    expect(alertIndex).toBeGreaterThan(0);
    expect(service.events.slice(0, alertIndex).every((event) => event.eventType === "RESOLVE")).toBe(true);
    expect(service.status).toBe("RESOLVED");
  });

  test("retains a primary failure when cleanup cannot be verified", async () => {
    const service = canaryService({ cleanupDeliveryFails: true });
    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        fetchFn: service.fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  test("does not start ALERT after pre-cleanup consumes the cleanup reserve", async () => {
    let now = 0;
    const service = canaryService();
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await service.fetchFn(input, init);
      if (request.url.includes("/alerts?") && service.events.length === 4) {
        now = 250_000;
      }
      return response;
    };
    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        fetchFn,
        now: () => now,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("cannot start without its cleanup reserve");
    expect(service.events.some((event) => event.eventType === "ALERT")).toBe(false);
  });
});

function canaryService(options: {
  existing?: boolean;
  status?: "PENDING" | "RESOLVED";
  deliveries?: number;
  deferAlertAcceptance?: boolean;
  cleanupDeliveryFails?: boolean;
} = {}) {
  const events: Array<{ alertKey: string; eventType: string }> = [];
  let existing = options.existing ?? false;
  let status = options.status ?? "PENDING";
  let deliveries = options.deliveries ?? 0;
  let pendingAlert = false;
  const fetchFn: Fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url.endsWith("/events")) {
      const body = (await request.json()) as { alertKey: string; eventType: string };
      events.push(body);
      if (body.eventType === "ALERT") {
        if (options.deferAlertAcceptance) pendingAlert = true;
        else {
          existing = true;
          status = "PENDING";
          deliveries += 1;
        }
      }
      if (body.eventType === "RESOLVE" && existing) {
        status = "RESOLVED";
        if (!options.cleanupDeliveryFails) deliveries += 1;
      }
      return new Response(null, { status: 202 });
    }
    if (request.url.includes("/alerts?")) {
      if (pendingAlert) {
        pendingAlert = false;
        existing = true;
        status = "PENDING";
        deliveries += 1;
      }
      return Response.json(
        existing
          ? [{ id: 99, alertKey: canaryAlertKey(), status }]
          : [],
      );
    }
    if (request.url.endsWith("/alerts/99/actions")) {
      return Response.json({
        alertActionId: 72,
        history: Array.from({ length: deliveries }, () => ({ success: true })),
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  };
  return {
    events,
    fetchFn,
    get status() {
      return status;
    },
  };
}

function fakeFetch(requests: Request[], responses: Response[]): Fetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
}
