import { describe, expect, test } from "bun:test";

import {
  ALERT_TRIGGER_TYPES,
  desiredAlertAction,
  equivalentAlertAction,
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

  test("proves webhook action success and resolves its unique canary", async () => {
    const requests: Request[] = [];
    const responses = [
      new Response(null, { status: 202 }),
      new Response(null, { status: 202 }),
    ];
    let canaryKey = "";
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST" && request.url.endsWith("/events")) {
        const body = (await request.clone().json()) as Record<string, unknown>;
        if (body.eventType === "ALERT") canaryKey = String(body.alertKey);
        return responses.shift()!;
      }
      if (request.url.includes("/alerts?")) {
        const resolveSent = requests.filter(
          (value) => value.method === "POST" && value.url.endsWith("/events"),
        ).length > 1;
        return Response.json([
          {
            id: 99,
            alertKey: canaryKey,
            status: resolveSent ? "RESOLVED" : "PENDING",
          },
        ]);
      }
      if (request.url.endsWith("/alerts/99/actions")) {
        const resolveSent = requests.filter(
          (value) => value.method === "POST" && value.url.endsWith("/events"),
        ).length > 1;
        return Response.json({
          alertActionId: 72,
          history: resolveSent
            ? [{ success: true }, { success: true }]
            : [{ success: true }],
        });
      }
      return responses.shift()!;
    };

    await verifyIlertAlertStreamCanary({
      actionId: "72",
      apiKey: API_KEY,
      integrationKey: "test-integration-key",
      fetchFn,
      sleep: async () => undefined,
      runId: "100",
      runAttempt: "2",
    });
    const eventBodies = await Promise.all(
      requests
        .filter((request) => request.method === "POST")
        .map((request) => request.clone().json() as Promise<Record<string, unknown>>),
    );
    expect(eventBodies.map((body) => body.eventType)).toEqual(["ALERT", "RESOLVE"]);
    expect(eventBodies[0]!.alertKey).toBe(eventBodies[1]!.alertKey);
  });

  test("resolves an accepted canary when delivery verification fails", async () => {
    const eventTypes: unknown[] = [];
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && request.url.endsWith("/events")) {
        const body = (await request.json()) as Record<string, unknown>;
        eventTypes.push(body.eventType);
        return new Response(null, { status: 202 });
      }
      if (request.url.includes("/alerts?")) return Response.json([]);
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };

    try {
      await verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        fetchFn,
        sleep: async () => undefined,
        runId: "100",
        runAttempt: "2",
      });
      throw new Error("expected canary to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
    }
    expect(eventTypes).toEqual(["ALERT", "RESOLVE"]);
  });

  test("resolves the same key after an ambiguous ALERT failure", async () => {
    const eventBodies: Record<string, unknown>[] = [];
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && request.url.endsWith("/events")) {
        const body = (await request.json()) as Record<string, unknown>;
        eventBodies.push(body);
        if (body.eventType === "ALERT") throw new Error("ambiguous ALERT failure");
        return new Response(null, { status: 202 });
      }
      if (request.url.includes("/alerts?")) {
        return Response.json([
          { id: 99, alertKey: eventBodies[0]?.alertKey, status: "RESOLVED" },
        ]);
      }
      if (request.url.endsWith("/alerts/99/actions")) {
        return Response.json({
          alertActionId: 72,
          history: [{ success: true }],
        });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };

    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("ambiguous ALERT failure");
    expect(eventBodies.map((body) => body.eventType)).toEqual(["ALERT", "RESOLVE"]);
    expect(eventBodies[0]?.alertKey).toBe(eventBodies[1]?.alertKey);
  });

  test("retries and verifies cleanup when the first resolution delivery is unconfirmed", async () => {
    const eventTypes: unknown[] = [];
    let canaryKey = "";
    let resolves = 0;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && request.url.endsWith("/events")) {
        const body = (await request.json()) as Record<string, unknown>;
        eventTypes.push(body.eventType);
        canaryKey = String(body.alertKey);
        if (body.eventType === "RESOLVE") resolves += 1;
        return new Response(null, { status: 202 });
      }
      if (request.url.includes("/alerts?")) {
        return Response.json([
          {
            id: 99,
            alertKey: canaryKey,
            status: resolves > 1 ? "RESOLVED" : "PENDING",
          },
        ]);
      }
      if (request.url.endsWith("/alerts/99/actions")) {
        return Response.json({
          alertActionId: 72,
          history: Array.from({ length: resolves > 1 ? 2 : 1 }, () => ({
            success: true,
          })),
        });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };

    await expect(
      verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        fetchFn,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("did not confirm successful Postil webhook delivery");
    expect(eventTypes).toEqual(["ALERT", "RESOLVE", "RESOLVE"]);
  });

  test("retains primary and cleanup failures", async () => {
    let resolves = 0;
    let canaryKey = "";
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && request.url.endsWith("/events")) {
        const body = (await request.json()) as Record<string, unknown>;
        canaryKey = String(body.alertKey);
        if (body.eventType === "RESOLVE") {
          resolves += 1;
          return new Response(null, { status: resolves === 1 ? 500 : 502 });
        }
        return new Response(null, { status: 202 });
      }
      if (request.url.includes("/alerts?")) {
        return Response.json([{ id: 99, alertKey: canaryKey, status: "PENDING" }]);
      }
      if (request.url.endsWith("/alerts/99/actions")) {
        return Response.json({ alertActionId: 72, history: [{ success: true }] });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };

    try {
      await verifyIlertAlertStreamCanary({
        actionId: "72",
        apiKey: API_KEY,
        integrationKey: "test-integration-key",
        fetchFn,
        sleep: async () => undefined,
      });
      throw new Error("expected canary to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        expect.stringContaining("HTTP 500"),
        expect.stringContaining("HTTP 502"),
      ]);
    }
  });

  test("reserves canary time for verified cleanup after the primary deadline", async () => {
    let now = 0;
    let canaryKey = "";
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && request.url.endsWith("/events")) {
        const body = (await request.json()) as Record<string, unknown>;
        canaryKey = String(body.alertKey);
        if (body.eventType === "ALERT") now = 60_000;
        return new Response(null, { status: 202 });
      }
      if (request.url.includes("/alerts?")) {
        return Response.json([{ id: 99, alertKey: canaryKey, status: "RESOLVED" }]);
      }
      if (request.url.endsWith("/alerts/99/actions")) {
        return Response.json({ alertActionId: 72, history: [{ success: true }] });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
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
    ).rejects.toThrow("canary deadline expired");
  });
});

function fakeFetch(requests: Request[], responses: Response[]): Fetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
}
