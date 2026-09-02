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
const CANARY_CONTEXT = { runId: "12345", runAttempt: "2" };
type HistoryEntry = {
  alertActionId: string;
  alertId: number;
  id: string;
  success: true;
};
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

  test("fails closed when a valid alert-source relation is mixed with a malformed relation", () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET);
    const actual = structuredClone(desired) as Record<string, unknown>;
    actual.alertSources = [SOURCE, { id: "not-a-positive-integer" }];
    expect(equivalentAlertAction(actual, desired)).toBe(false);
  });

  test("fails closed when every alert-source relation is malformed", () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET);
    const actual = structuredClone(desired) as Record<string, unknown>;
    actual.alertSources = [{ id: 0 }];
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

  test("fails closed on an action detail that does not match its list identity", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET);
    const requests: Request[] = [];
    await expect(
      reconcileIlertAlertAction({
        apiKey: API_KEY,
        sourceId: SOURCE_ID,
        webhookSecret: WEBHOOK_SECRET,
        fetchFn: fakeFetch(requests, [
          Response.json(SOURCE),
          Response.json([{ id: "72" }]),
          Response.json({ ...desired, id: "73" }),
        ]),
      }),
    ).rejects.toThrow("detail for a different alert action");
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "GET"]);
  });

  test("fails closed when POST confirmation changes the created action identity", async () => {
    const requests: Request[] = [];
    await expect(
      reconcileIlertAlertAction({
        apiKey: API_KEY,
        sourceId: SOURCE_ID,
        webhookSecret: WEBHOOK_SECRET,
        fetchFn: fakeFetch(requests, [
          Response.json(SOURCE),
          Response.json([]),
          Response.json({ id: "71" }),
          Response.json({ ...desiredAlertAction(SOURCE, WEBHOOK_SECRET), id: "72" }),
        ]),
      }),
    ).rejects.toThrow("confirmation for a different alert action");
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "POST", "GET"]);
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
        Response.json({ ...desired, id: "72" }),
        Response.json({ ...desired, id: "72" }),
      ]),
    });
    expect(updated).toEqual({ actionId: "72", operation: "update" });
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

  test("fails closed when PUT confirmation changes the updated action identity", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET);
    const drifted = { ...desired, id: "72", triggerMode: "MANUAL" };
    const requests: Request[] = [];
    await expect(
      reconcileIlertAlertAction({
        apiKey: API_KEY,
        sourceId: SOURCE_ID,
        webhookSecret: WEBHOOK_SECRET,
        fetchFn: fakeFetch(requests, [
          Response.json(SOURCE),
          Response.json([{ id: "72" }]),
          Response.json(drifted),
          Response.json({ ...desired, id: "72" }),
          Response.json({ ...desired, id: "73" }),
        ]),
      }),
    ).rejects.toThrow("confirmation for a different alert action");
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "PUT",
      "GET",
    ]);
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

  test("accepts a valid new exact-match history record and stabilizes resolution", async () => {
    const service = canaryService();
    await verifyIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      ...CANARY_CONTEXT,
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    expect(canaryAlertKey(CANARY_CONTEXT.runId, CANARY_CONTEXT.runAttempt)).toBe(
      "postil-operator-alert-stream-canary-12345-2",
    );
    expect(canaryAlertKey("12346", CANARY_CONTEXT.runAttempt)).not.toBe(
      canaryAlertKey(CANARY_CONTEXT.runId, CANARY_CONTEXT.runAttempt),
    );
    expect(canaryAlertKey(CANARY_CONTEXT.runId, "3")).not.toBe(
      canaryAlertKey(CANARY_CONTEXT.runId, CANARY_CONTEXT.runAttempt),
    );
    expect(service.events.map((event) => event.eventType)).toEqual([
      "ALERT",
      "RESOLVE",
      "RESOLVE",
      "RESOLVE",
      "RESOLVE",
    ]);
    expect(service.events.every((event) => event.alertKey === canaryAlertKey(
      CANARY_CONTEXT.runId,
      CANARY_CONTEXT.runAttempt,
    ))).toBe(true);
  });

  test("finalizer resolves an open run-attempt canary with newer delivery evidence", async () => {
    const service = canaryService({ existing: true, status: "PENDING", deliveries: 1 });
    await finalizeIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      ...CANARY_CONTEXT,
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    expect(service.events).toHaveLength(4);
    expect(service.events.every((event) => event.alertKey === canaryAlertKey(
      CANARY_CONTEXT.runId,
      CANARY_CONTEXT.runAttempt,
    ))).toBe(true);
    expect(service.status).toBe("RESOLVED");
  });

  test("does not accept stale successful history when ALERT delivery is dropped", async () => {
    const service = canaryService({
      existing: true,
      status: "RESOLVED",
      deliveries: 1,
      dropAlertDelivery: true,
    });
    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
        fetchFn: service.fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("did not confirm successful Postil webhook delivery");
  });

  test("fails closed on a successful history record for another alert", async () => {
    const service = canaryService({
      existing: true,
      historyEntry: (entry) => ({ ...entry, alertId: 100 }),
    });
    await expect(
      finalizeIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
        fetchFn: service.fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("invalid action history");
  });

  test("fails closed on a successful history record for another action", async () => {
    const service = canaryService({
      existing: true,
      historyEntry: (entry) => ({ ...entry, alertActionId: "73" }),
    });
    await expect(
      finalizeIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
        fetchFn: service.fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("invalid action history");
  });

  test("ignores valid successful history records for another action", async () => {
    const service = canaryService({ existing: true, otherActionRecord: true });
    await finalizeIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      ...CANARY_CONTEXT,
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    expect(service.status).toBe("RESOLVED");
  });

  test("fails closed on successful history records missing required identities", async () => {
    const missingIdentity = [
      ({ id: _id, ...entry }: HistoryEntry) => entry,
      ({ alertId: _alertId, ...entry }: HistoryEntry) => entry,
      ({ alertActionId: _alertActionId, ...entry }: HistoryEntry) => entry,
    ];
    for (const historyEntry of missingIdentity) {
      const service = canaryService({ existing: true, historyEntry });
      await expect(
        finalizeIlertAlertStreamCanary({
          actionId: "72",
          apiKey: API_KEY,
          integrationKey: "test-integration-key",
          ...CANARY_CONTEXT,
          fetchFn: service.fetchFn,
          sleep: async () => undefined,
        }),
      ).rejects.toThrow("invalid action history");
    }
  });

  test("fails closed on a successful history record with a malformed identity", async () => {
    const service = canaryService({
      existing: true,
      historyEntry: (entry) => ({ ...entry, id: "malformed history identity" }),
    });
    await expect(
      finalizeIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
        fetchFn: service.fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("invalid action history");
  });

  test("fails closed when successful history reuses an identity", async () => {
    const service = canaryService({
      existing: true,
      deliveries: 2,
      historyEntry: (entry) => ({ ...entry, id: "reused-history-id" }),
    });
    await expect(
      finalizeIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
        fetchFn: service.fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("invalid action history");
  });

  test("selects a new alert ID when the current records are reordered", async () => {
    const service = canaryService({
      existing: true,
      status: "RESOLVED",
      deliveries: 1,
    });
    await verifyIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      ...CANARY_CONTEXT,
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    expect(service.status).toBe("RESOLVED");
  });

  test("does not mistake a delayed pre-clean RESOLVE delivery for a dropped ALERT", async () => {
    const service = canaryService({
      delayedPrecleanResolve: true,
      dropAlertDelivery: true,
      existing: true,
      status: "PENDING",
      deliveries: 1,
    });
    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
        fetchFn: service.fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("did not confirm successful Postil webhook delivery");
  });

  test("fails closed when ALERT creates multiple current canary records", async () => {
    const service = canaryService({ ambiguousAlert: true });
    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
        fetchFn: service.fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  test("treats an already resolved uniquely identified canary as complete", async () => {
    const service = canaryService({
      existing: true,
      status: "RESOLVED",
      deliveries: 1,
      cleanupDeliveryFails: true,
    });
    await finalizeIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      ...CANARY_CONTEXT,
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    expect(service.events).toHaveLength(0);
  });

  test("finalizer searches source-scoped alert pages for the reconstructed key", async () => {
    const alertRequests: Request[] = [];
    let actionHistoryRequests = 0;
    const unrelated = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      alertKey: `other-${index}`,
      status: "RESOLVED",
    }));
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("/alerts?")) {
        alertRequests.push(request);
        return Response.json(
          new URL(request.url).searchParams.get("start-index") === "0"
            ? unrelated
            : [{
                id: 999,
                alertKey: canaryAlertKey(
                  CANARY_CONTEXT.runId,
                  CANARY_CONTEXT.runAttempt,
                ),
                status: "RESOLVED",
              }],
        );
      }
      if (request.url.endsWith("/alerts/999/actions")) {
        actionHistoryRequests += 1;
        return Response.json({ alertActionId: 72, history: [] });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    await finalizeIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      ...CANARY_CONTEXT,
      sourceId: SOURCE_ID,
      fetchFn,
      sleep: async () => undefined,
    });
    expect(alertRequests).toHaveLength(2);
    expect(alertRequests.every((request) => request.url.includes("sources=42"))).toBe(true);
    expect(actionHistoryRequests).toBe(0);
  });

  test("closes an ALERT accepted after a polling delay", async () => {
    const service = canaryService({ deferAlertAcceptance: true });
    await verifyIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      ...CANARY_CONTEXT,
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
    });
    const alertIndex = service.events.findIndex((event) => event.eventType === "ALERT");
    expect(alertIndex).toBe(0);
    expect(service.status).toBe("RESOLVED");
  });

  test("retains a primary failure when cleanup cannot be verified", async () => {
    const service = canaryService({ cleanupDeliveryFails: true });
    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
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
      if (request.url.includes("/alerts?") && service.events.length === 0) {
        now = 250_000;
      }
      return response;
    };
    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        ...CANARY_CONTEXT,
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
  dropAlertDelivery?: boolean;
  cleanupDeliveryFails?: boolean;
  ambiguousAlert?: boolean;
  delayedPrecleanResolve?: boolean;
  historyEntry?: (entry: HistoryEntry) => unknown;
  otherActionRecord?: boolean;
} = {}) {
  const events: Array<{ alertKey: string; eventType: string }> = [];
  const alerts: Array<{
    deliveries: number;
    id: number;
    status: "PENDING" | "RESOLVED";
  }> = options.existing
    ? [{ deliveries: options.deliveries ?? 0, id: 98, status: options.status ?? "PENDING" }]
    : [];
  let pendingAlert = false;
  let alertSent = false;
  let delayedPrecleanDelivery = false;
  const fetchFn: Fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url.endsWith("/events")) {
      const body = (await request.json()) as { alertKey: string; eventType: string };
      events.push(body);
      if (body.eventType === "ALERT") {
        alertSent = true;
        if (options.deferAlertAcceptance) pendingAlert = true;
        else if (!options.dropAlertDelivery) addAlert();
      }
      if (body.eventType === "RESOLVE") {
        for (const alert of alerts.filter((item) => item.status !== "RESOLVED")) {
          alert.status = "RESOLVED";
          if (options.delayedPrecleanResolve && !alertSent) {
            delayedPrecleanDelivery = true;
          } else if (!options.cleanupDeliveryFails) {
            alert.deliveries += 1;
          }
        }
      }
      return new Response(null, { status: 202 });
    }
    if (request.url.includes("/alerts?")) {
      if (pendingAlert) {
        pendingAlert = false;
        addAlert();
      }
      if (delayedPrecleanDelivery && (alertSent || events.some((event) => event.eventType === "RESOLVE"))) {
        delayedPrecleanDelivery = false;
        const existing = alerts.find((alert) => alert.id === 98);
        if (existing) existing.deliveries += 1;
      }
      return Response.json(
        [...alerts].reverse().map((alert) => ({
          id: alert.id,
          alertKey: canaryAlertKey(CANARY_CONTEXT.runId, CANARY_CONTEXT.runAttempt),
          status: alert.status,
        })),
      );
    }
    const actionMatch = request.url.match(/\/alerts\/([0-9]+)\/actions$/u);
    if (actionMatch) {
      const alert = alerts.find((item) => item.id === Number(actionMatch[1]));
      if (!alert) throw new Error(`unknown alert: ${request.url}`);
      const postilRecord = {
        alertActionId: 72,
        history: Array.from({ length: alert.deliveries }, (_, index) =>
          options.historyEntry?.({
            alertActionId: "72",
            alertId: alert.id,
            id: `delivery-${index + 1}`,
            success: true,
          }) ?? {
            alertActionId: "72",
            alertId: alert.id,
            id: `delivery-${index + 1}`,
            success: true,
          },
        ),
      };
      if (!options.otherActionRecord) return Response.json(postilRecord);
      return Response.json([
        {
          alertActionId: "73",
          history: [{
            alertActionId: "73",
            alertId: alert.id,
            id: `other-action-delivery-${alert.deliveries}`,
            success: true,
          }],
        },
        postilRecord,
      ]);
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  };
  return {
    events,
    fetchFn,
    get status() {
      return alerts.at(-1)?.status;
    },
  };

  function addAlert() {
    const id = alerts.length === 0 ? 99 : Math.max(...alerts.map((alert) => alert.id)) + 1;
    alerts.push({ deliveries: 1, id, status: "PENDING" });
    if (options.ambiguousAlert) {
      alerts.push({ deliveries: 1, id: id + 1, status: "PENDING" });
    }
  }
}

function fakeFetch(requests: Request[], responses: Response[]): Fetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
}
