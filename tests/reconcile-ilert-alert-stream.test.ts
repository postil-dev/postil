import { describe, expect, test } from "bun:test";

import {
  ALERT_TRIGGER_TYPES,
  CANARY_RERUN_LOOKBACK_MS,
  canaryAlertKey,
  desiredAlertAction,
  equivalentAlertAction,
  finalizeIlertWebhookCanary,
  MAX_CANARY_RUN_ATTEMPT,
  type Fetch,
  parseReceiverOrigin,
  reconcileIlertAlertAction,
  runCli,
  sweepIlertWebhookCanaryOrphans,
  validWebhookSecret,
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
  integrationKey: INTEGRATION_KEY,
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
  test("shares the receiver-secret contract with deployment validation", async () => {
    expect(validWebhookSecret(WEBHOOK_SECRET)).toBe(true);
    expect(validWebhookSecret("x".repeat(32))).toBe(false);
    expect(validWebhookSecret("short")).toBe(false);
    await runCli({
      args: ["--validate-webhook-secret"],
      env: { POSTIL_ILERT_WEBHOOK_SECRET: WEBHOOK_SECRET },
      log: () => undefined,
    });
    await expect(runCli({
      args: ["--validate-webhook-secret"],
      env: { POSTIL_ILERT_WEBHOOK_SECRET: "x".repeat(32) },
      log: () => undefined,
    })).rejects.toThrow("POSTIL_ILERT_WEBHOOK_SECRET must contain");
  });

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
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/alert-sources/${SOURCE_ID}`);
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

  test("rejects an integration-key mismatch before action mutation", async () => {
    const requests: Request[] = [];
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({ ...SOURCE, integrationKey: "different-integration-key" });
      },
    })).rejects.toThrow("integration binding validation failed");
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/alert-sources/${SOURCE_ID}`);
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
    expect(requests).toHaveLength(5);
    expect(requests[1]!.url).not.toContain("source=");
    expect(requests[2]!.url).toContain("start-index=99");
    expect(requests[4]!.url).toContain("start-index=99");
  });

  test("fails before POST when a disappearing action shifts the reserved action across pages", async () => {
    const requests: Request[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(index + 1),
      name: `Unrelated action ${index + 1}`,
    }));
    const shifted = [
      ...firstPage.slice(1),
      { id: "101", name: "Postil operator alert stream" },
    ];
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.pathname === "/api/alert-actions") {
          const start = Number(url.searchParams.get("start-index"));
          const scan = requests.filter((seen) =>
            new URL(seen.url).pathname === "/api/alert-actions" &&
            new URL(seen.url).searchParams.get("start-index") === "0"
          ).length;
          if (scan === 1) return Response.json(start === 0 ? firstPage : []);
          return Response.json(start === 0 ? shifted : []);
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("alert-action inventory changed during continuity validation");
    expect(requests.some((request) =>
      request.method === "POST" && new URL(request.url).pathname === "/api/alert-actions"
    )).toBe(false);
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
    let updated = false;
    const result = await reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json([{ id: "72", name: String(desired.name) }]);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "GET") {
          return Response.json(updated ? { ...desired, id: "72" } : drifted);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "PUT") {
          updated = true;
          return Response.json({ ...desired, id: "72" });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    });
    expect(result).toEqual({ actionId: "72", operation: "update" });
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
    let updated = false;
    await reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json([{ id: "72", name: String(desired.name) }]);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "GET") {
          return Response.json(updated ? { ...desired, id: "72" } : legacy);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "PUT") {
          updated = true;
          return Response.json({ ...desired, id: "72" });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
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
        Response.json(SOURCE),
        Response.json(desired),
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

  test("propagates a receiver preflight failure instead of recovering a hypothetical created action", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    let actionInventories = 0;
    let receiverPreflights = 0;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) {
          receiverPreflights += 1;
          return receiverPreflights === 1
            ? new Response(null, { status: 204 })
            : Response.json({ error: "unavailable" }, { status: 503 });
        }
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          actionInventories += 1;
          // This equivalent action is visible only if failed pre-POST
          // validation incorrectly enters ambiguous-create recovery.
          return Response.json(actionInventories <= 4 ? [] : [{ id: "73", name: desired.name }]);
        }
        if (url.pathname === "/api/alert-actions/73") return Response.json({ ...desired, id: "73" });
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("credential preflight failed with HTTP 503");
    expect(receiverPreflights).toBeGreaterThanOrEqual(2);
    expect(actionInventories).toBe(4);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("creates a missing action only after receiver preflight", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    let created = false;
    const result = await reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json(created ? [{ id: "71", name: desired.name }] : []);
        }
        if (url.pathname === "/api/alert-actions" && request.method === "POST") {
          created = true;
          return Response.json({ ...desired, id: "71" });
        }
        if (url.pathname === "/api/alert-actions/71") return Response.json({ ...desired, id: "71" });
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    });
    expect(result).toEqual({ actionId: "71", operation: "create" });
    const create = requests.find((request) =>
      request.method === "POST" && request.url.includes("/alert-actions"),
    );
    expect(create).toBeDefined();
    const createIndex = requests.indexOf(create!);
    const preflightIndexes = requests.flatMap((request, index) =>
      request.url === `${RECEIVER_ORIGIN}/api/webhooks/ilert` ? [index] : [],
    );
    expect(preflightIndexes).toHaveLength(2);
    expect(preflightIndexes[1]).toBeLessThan(createIndex);
    expect(requests.slice(preflightIndexes[1]! + 1, createIndex).some((request) =>
      request.method === "GET" && new URL(request.url).pathname === "/api/alert-actions"
    )).toBe(true);
    const body = await create!.json() as {
      alertSources: Array<Record<string, unknown>>;
    };
    expect(body.alertSources[0]).not.toHaveProperty("integrationKey");
  });

  test("refuses POST when a reserved action appears during receiver preflight", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    let boundary = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) {
          boundary = true;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/alert-actions") {
          return Response.json(boundary ? [{ id: "73", name: desired.name }] : []);
        }
        if (url.pathname === "/api/alert-actions/73") {
          return Response.json({ ...desired, id: "73" });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("appeared before creation");
    expect(requests.some((request) =>
      request.method === "POST" || request.method === "PUT"
    )).toBe(false);
  });

  test("refuses POST when the action inventory changes during its immediate attempt preflight", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    let receiverPreflights = 0;
    let appearedDuringAttemptPreflight = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) {
          receiverPreflights += 1;
          if (receiverPreflights === 2) appearedDuringAttemptPreflight = true;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json(appearedDuringAttemptPreflight
            ? [{ id: "73", name: desired.name }]
            : []);
        }
        if (url.pathname === "/api/alert-actions/73" && request.method === "GET") {
          return Response.json({ ...desired, id: "73" });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("appeared before creation");
    expect(receiverPreflights).toBe(2);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  test("revalidates the source binding after receiver preflight before POST", async () => {
    const requests: Request[] = [];
    let boundary = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) {
          return Response.json(boundary
            ? { ...SOURCE, integrationKey: "concurrently-replaced-key" }
            : SOURCE);
        }
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) {
          boundary = true;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/alert-actions") return Response.json([]);
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("integration binding validation failed");
    expect(requests.filter((request) =>
      new URL(request.url).pathname.startsWith("/api/alert-sources/")
    )).toHaveLength(2);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("refuses PUT when a reserved action changes during receiver preflight", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const initial = { ...desired, conditions: "alert.priority == 'HIGH'", id: "72" };
    const concurrent = { ...initial, conditions: "alert.status == 'PENDING'" };
    const requests: Request[] = [];
    let boundary = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) {
          boundary = true;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/alert-actions") {
          return Response.json([{ id: "72", name: desired.name }]);
        }
        if (url.pathname === "/api/alert-actions/72") {
          return Response.json(boundary ? concurrent : initial);
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("changed before mutation");
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
  });

  test("fails closed when a second reserved action appears during PUT", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const drifted = { ...desired, conditions: "alert.priority == 'HIGH'", id: "72" };
    const requests: Request[] = [];
    let mutated = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (request.method === "PUT" && url.pathname === "/api/alert-actions/72") {
          mutated = true;
          return Response.json({ ...desired, id: "72" });
        }
        if (url.pathname === "/api/alert-actions") {
          return Response.json(mutated
            ? [{ id: "72", name: desired.name }, { id: "73", name: desired.name }]
            : [{ id: "72", name: desired.name }]);
        }
        if (url.pathname === "/api/alert-actions/72") {
          return Response.json(mutated ? { ...desired, id: "72" } : drifted);
        }
        if (url.pathname === "/api/alert-actions/73") return Response.json({ ...desired, id: "73" });
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("Multiple Postil webhook alert actions exist");
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  test("fails closed when a second reserved action appears during POST", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const requests: Request[] = [];
    let mutated = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (request.method === "POST" && url.pathname === "/api/alert-actions") {
          mutated = true;
          return Response.json({ ...desired, id: "72" });
        }
        if (url.pathname === "/api/alert-actions") {
          return Response.json(mutated
            ? [{ id: "72", name: desired.name }, { id: "73", name: desired.name }]
            : []);
        }
        if (url.pathname === "/api/alert-actions/72" || url.pathname === "/api/alert-actions/73") {
          return Response.json({ ...desired, id: url.pathname.endsWith("72") ? "72" : "73" });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("Multiple Postil webhook alert actions exist");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("revalidates the source binding immediately before action mutation", async () => {
    const requests: Request[] = [];
    let sourceReads = 0;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) {
          sourceReads += 1;
          return Response.json(sourceReads >= 3
            ? { ...SOURCE, integrationKey: "rotated-key" }
            : SOURCE);
        }
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (url.pathname === "/api/alert-actions") return Response.json([]);
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("integration binding validation failed");
    expect(requests.some((request) => request.method === "POST" || request.method === "PUT")).toBe(false);
  });

  test("does not retry PUT after a transient response rotates the source binding", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const drifted = { ...desired, conditions: "alert.priority == 'HIGH'", id: "72" };
    const requests: Request[] = [];
    let rotated = false;
    let updateAttempts = 0;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) {
          return Response.json(rotated ? { ...SOURCE, integrationKey: "rotated-key" } : SOURCE);
        }
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json([{ id: "72", name: desired.name }]);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "GET") return Response.json(drifted);
        if (url.pathname === "/api/alert-actions/72" && request.method === "PUT") {
          updateAttempts += 1;
          rotated = true;
          return new Response(null, { status: 503 });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("integration binding validation failed");
    expect(updateAttempts).toBe(1);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  test("does not retry PUT after receiver preflight fails during backoff", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const drifted = { ...desired, conditions: "alert.priority == 'HIGH'", id: "72" };
    const requests: Request[] = [];
    let receiverPreflights = 0;
    let updateAttempts = 0;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) {
          receiverPreflights += 1;
          return new Response(null, { status: receiverPreflights >= 3 ? 401 : 204 });
        }
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json([{ id: "72", name: desired.name }]);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "GET") {
          return Response.json(drifted);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "PUT") {
          updateAttempts += 1;
          return new Response(null, { status: 503 });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("credential preflight failed with HTTP 401");
    expect(receiverPreflights).toBe(3);
    expect(updateAttempts).toBe(1);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  test("does not dispatch PUT when its validation crosses the reconciliation deadline", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const drifted = { ...desired, conditions: "alert.priority == 'HIGH'", id: "72" };
    const requests: Request[] = [];
    let currentTime = 0;
    let receiverPreflights = 0;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      now: () => currentTime,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) {
          receiverPreflights += 1;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json([{ id: "72", name: desired.name }]);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "GET") {
          if (receiverPreflights === 2) currentTime = 180_001;
          return Response.json(drifted);
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("deadline expired");
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);
  });

  test("does not retry PUT after a transient response changes the reserved action", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const drifted = { ...desired, conditions: "alert.priority == 'HIGH'", id: "72" };
    const concurrent = { ...drifted, conditions: "alert.status == 'PENDING'" };
    const requests: Request[] = [];
    let changed = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json([{ id: "72", name: desired.name }]);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "GET") {
          return Response.json(changed ? concurrent : drifted);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "PUT") {
          changed = true;
          return new Response(null, { status: 503 });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("changed before mutation");
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  test("does not retry PUT when the reserved action changes during retry preflight", async () => {
    const desired = desiredAlertAction(SOURCE, WEBHOOK_SECRET, RECEIVER_ORIGIN);
    const drifted = { ...desired, conditions: "alert.priority == 'HIGH'", id: "72" };
    const concurrent = { ...drifted, conditions: "alert.status == 'PENDING'" };
    const requests: Request[] = [];
    let receiverPreflights = 0;
    let changedDuringRetryPreflight = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) {
          receiverPreflights += 1;
          if (receiverPreflights === 3) changedDuringRetryPreflight = true;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/alert-actions" && request.method === "GET") {
          return Response.json([{ id: "72", name: desired.name }]);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "GET") {
          return Response.json(changedDuringRetryPreflight ? concurrent : drifted);
        }
        if (url.pathname === "/api/alert-actions/72" && request.method === "PUT") {
          return new Response(null, { status: 503 });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("changed before mutation");
    expect(receiverPreflights).toBe(3);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  test("does not issue a second POST after an ambiguous transient creation response", async () => {
    const requests: Request[] = [];
    let rotated = false;
    await expect(reconcileIlertAlertAction({
      ...reconcileOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) {
          return Response.json(rotated ? { ...SOURCE, integrationKey: "rotated-key" } : SOURCE);
        }
        if (url.href === `${RECEIVER_ORIGIN}/api/webhooks/ilert`) return new Response(null, { status: 204 });
        if (url.pathname === "/api/alert-actions" && request.method === "GET") return Response.json([]);
        if (url.pathname === "/api/alert-actions" && request.method === "POST") {
          rotated = true;
          return new Response(null, { status: 503 });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("iLert alert-action creation was ambiguous");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
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
      })).rejects.toThrow("inventory changed during continuity validation");
      expect(requests.filter((request) =>
        request.method === "POST" && request.url.includes("/alert-actions")
      )).toHaveLength(0);
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
    expect(requests).toHaveLength(4);
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
    expect(canaryAlertKey(RUN_ID, "51")).toBe(
      "postil-ilert-webhook-canary-12345-51",
    );
  });

  test("accepts attempt 51 as a finalizer sweep ceiling", async () => {
    const service = canaryService({
      initialAlerts: [
        {
          alertKey: canaryAlertKey(RUN_ID, "50"),
          id: 98,
          status: "PENDING",
        },
      ],
    });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
      runAttempt: "1",
      sweepAttempt: "51",
    });
    expect(service.alertListRequests).toBeGreaterThan(0);
    expect(service.requests.some((request) => request.url.endsWith("/alerts/98/resolve"))).toBe(true);
  });

  test("recovers an old-run orphan without touching routine, lookalike, or other-source alerts", async () => {
    const oldRunId = "67890";
    const service = canaryService({
      initialAlerts: [
        {
          alertKey: canaryAlertKey(oldRunId, "2"),
          id: 98,
          status: "PENDING",
        },
        {
          alertKey: "postil-production-monitor",
          id: 99,
          status: "PENDING",
        },
        {
          alertKey: "postil-ilert-webhook-canary-not-a-run-id",
          id: 100,
          status: "PENDING",
        },
        {
          alertKey: canaryAlertKey(oldRunId, "3"),
          id: 101,
          sourceId: SOURCE_ID + 1,
          status: "PENDING",
        },
      ],
    });
    await sweepIlertWebhookCanaryOrphans({
      apiKey: API_KEY,
      fetchFn: service.fetchFn,
      sleep: async () => undefined,
      sourceId: SOURCE_ID,
    });
    const resolvedIds = service.requests
      .filter((request) => request.method === "PUT")
      .map((request) => /\/alerts\/([1-9][0-9]*)\/resolve$/u.exec(new URL(request.url).pathname)?.[1]);
    expect(resolvedIds).toEqual(["98"]);
    expect(service.events).toEqual([]);
    expect(service.statuses).toEqual(["RESOLVED", "PENDING", "PENDING", "PENDING"]);
  });

  test("resolves a retained exact ID then fails closed after a continuity mismatch", async () => {
    const service = canaryService({
      initialAlerts: [{
        alertKey: canaryAlertKey("67890", "2"),
        id: 98,
        status: "PENDING",
      }],
    });
    let alertCountRequests = 0;
    let alertListRequests = 0;
    await expect(sweepIlertWebhookCanaryOrphans({
      apiKey: API_KEY,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/api/alerts/count") {
          alertCountRequests += 1;
          return Response.json({ count: alertCountRequests < 3 ? 1 : 0 });
        }
        if (new URL(request.url).pathname === "/api/alerts") {
          alertListRequests += 1;
          if (alertListRequests === 2) return Response.json([]);
        }
        return service.fetchFn(input, init);
      },
      sleep: async () => undefined,
      sourceId: SOURCE_ID,
    })).rejects.toThrow("inventory was incomplete after resolving retained alerts");
    expect(service.requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")
    )).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("rejects attempt 52 for deterministic keys and finalizer sweeps", async () => {
    expect(() => canaryAlertKey(RUN_ID, "52")).toThrow(
      "GitHub run attempt must be between 1 and 51",
    );
    await expect(finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      runAttempt: "1",
      sweepAttempt: "52",
    })).rejects.toThrow("GitHub run attempt must be between 1 and 51");
  });

  test("documents the runtime canary rerun ceiling", async () => {
    const architecture = await Bun.file(new URL("../ARCHITECTURE.md", import.meta.url)).text();
    expect(architecture).toContain(
      `GitHub's 1 through ${MAX_CANARY_RUN_ATTEMPT} attempt range`,
    );
    expect(CANARY_RERUN_LOOKBACK_MS).toBe(32 * 24 * 60 * 60 * 1_000);
    expect(architecture).toContain("exact 32-day run-wide report-time window");
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

  test("revalidates the source binding after preclean before ALERT", async () => {
    const service = canaryService();
    let precleanListed = false;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/alerts") precleanListed = true;
      if (url.pathname.startsWith("/api/alert-sources/") && precleanListed) {
        return Response.json({ ...SOURCE, integrationKey: "rotated-key" });
      }
      return service.fetchFn(input, init);
    };
    let error: unknown;
    try {
      await verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn,
        runAttempt: "2",
      });
    } catch (caught) {
      error = caught;
    }
    expect(errorMessages(error)).toContain("iLert integration binding validation failed");
    expect(service.events).toHaveLength(0);
  });

  test("uses management exact-ID cleanup after the Event API key rotates", async () => {
    const service = canaryService();
    let sourceReads = 0;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith("/api/alert-sources/")) {
        sourceReads += 1;
        if (sourceReads >= 3) return Response.json({ ...SOURCE, integrationKey: "rotated-key" });
      }
      return service.fetchFn(input, init);
    };
    await verifyIlertWebhookCanary({ ...canaryOptions, fetchFn });
    expect(service.events).toEqual([{
      alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
      eventType: "ALERT",
    }]);
    expect(service.requests.some((request) =>
      request.method === "PUT" && /\/alerts\/\d+\/resolve$/u.test(new URL(request.url).pathname)
    )).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("retains a discovered exact ID before receiver evidence and uses it after later discovery failure", async () => {
    const service = canaryService();
    let inventoryListings = 0;
    await expect(verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/alerts" && request.method === "GET") {
          inventoryListings += 1;
          if (inventoryListings > 2) return new Response(null, { status: 503 });
        }
        if (
          url.href.startsWith(`${RECEIVER_ORIGIN}/api/webhooks/ilert?`) &&
          url.searchParams.get("eventType") === "alert-created"
        ) {
          return Response.json({ received: false });
        }
        return service.fetchFn(input, init);
      },
    })).rejects.toThrow("iLert management request failed with HTTP 503");
    expect(service.events.filter((event) => event.eventType === "RESOLVE")).toEqual([]);
    expect(service.requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/99/resolve")
    )).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("reports an Event API binding failure while exact-ID cleanup survives rotation", async () => {
    const service = canaryService();
    let rotated = false;
    let alertResponseLost = true;
    let error: unknown;
    try {
      await verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname.startsWith("/api/alert-sources/") && rotated) {
            return Response.json({ ...SOURCE, integrationKey: "rotated-key" });
          }
          const response = await service.fetchFn(input, init);
          if (
            alertResponseLost &&
            request.method === "POST" &&
            request.url.endsWith("/events")
          ) {
            alertResponseLost = false;
            rotated = true;
            return new Response(null, { status: 503 });
          }
          return response;
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(errorMessages(error)).toContain("iLert integration binding validation failed");
    expect(service.events.filter((event) => event.eventType === "ALERT")).toHaveLength(1);
    expect(service.requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/99/resolve")
    )).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
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

  test("does not retry ALERT after a transient response rotates the source binding", async () => {
    const service = canaryService({ alertRetryAfter: "0" });
    let rotated = false;
    let error: unknown;
    try {
      await verifyIlertWebhookCanary({
        ...canaryOptions,
        fetchFn: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.startsWith("/api/alert-sources/") && rotated) {
          return Response.json({ ...SOURCE, integrationKey: "rotated-key" });
        }
        const response = await service.fetchFn(input, init);
        if (request.method === "POST" && request.url.endsWith("/events")) rotated = true;
        return response;
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(errorMessages(error)).toContain("iLert integration binding validation failed");
    expect(service.events.filter((event) => event.eventType === "ALERT")).toHaveLength(1);
  });

  test("does not dispatch an Event API mutation when validation exhausts the primary deadline", async () => {
    const service = canaryService();
    let currentTime = 0;
    let sourceReads = 0;
    await expect(verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.startsWith("/api/alert-sources/")) {
          sourceReads += 1;
          if (sourceReads === 2) currentTime = 360_001;
          return Response.json(SOURCE);
        }
        return service.fetchFn(input, init);
      },
      now: () => currentTime,
      sleep: async () => undefined,
    })).rejects.toThrow("cleanup could not be verified");
    expect(service.requests.filter((request) =>
      request.method === "POST" && new URL(request.url).pathname === "/api/events"
    )).toHaveLength(0);
  });

  test("retries management exact-ID resolution after a transient response and Event API key rotation", async () => {
    const service = canaryService({ resolveRequestFailures: 1 });
    let rotated = false;
    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.startsWith("/api/alert-sources/") && rotated) {
          return Response.json({ ...SOURCE, integrationKey: "rotated-key" });
        }
        const response = await service.fetchFn(input, init);
        if (request.method === "PUT" && /\/alerts\/99\/resolve$/u.test(new URL(request.url).pathname)) {
          rotated = true;
        }
        return response;
      },
    });
    expect(service.requests.filter((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/99/resolve")
    )).toHaveLength(2);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("does not retry Event API RESOLVE after a transient response rotates the source binding", async () => {
    const service = canaryService({ eventResolveAlwaysFails: true, managementFailsAfterAlert: true });
    let rotated = false;
    await expect(verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.startsWith("/api/alert-sources/") && rotated) {
          return Response.json({ ...SOURCE, integrationKey: "rotated-key" });
        }
        const response = await service.fetchFn(input, init);
        if (request.method === "POST" && request.url.endsWith("/events")) {
          const body = await request.clone().json() as { eventType: string };
          if (body.eventType === "RESOLVE") rotated = true;
        }
        return response;
      },
    })).rejects.toThrow("cleanup could not be verified");
    expect(service.events.filter((event) => event.eventType === "RESOLVE")).toHaveLength(1);
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
    const discoveryUntil = discoveryWindows.map((query) => Date.parse(query.get("until")!));
    expect(discoveryWindows.every((query) =>
      Date.parse(query.get("until")!) - Date.parse(query.get("from")!) === CANARY_RERUN_LOOKBACK_MS
    )).toBe(true);
    expect(discoveryUntil.some((until) => until >= 16_000)).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED"]);
  });

  test("uses one exact 32-day all-state source-scoped window for every discovery query", async () => {
    let currentTime = (30 * 24 * 60 * 60 * 1_000) + (10 * 60 * 1_000);
    const service = canaryService({ alertReportTime: new Date(currentTime).toISOString() });
    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn: service.fetchFn,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    const inventoryQueries = service.requests
      .map((request) => new URL(request.url))
      .filter((url) => url.pathname === "/api/alerts" || url.pathname === "/api/alerts/count");
    expect(inventoryQueries.length).toBeGreaterThan(0);
    for (const url of inventoryQueries) {
      const query = url.searchParams;
      expect(query.get("sources")).toBe(String(SOURCE_ID));
      expect(query.getAll("states")).toEqual(["PENDING", "ACCEPTED", "RESOLVED"]);
      expect(Date.parse(query.get("until")!) - Date.parse(query.get("from")!))
        .toBe(CANARY_RERUN_LOOKBACK_MS);
      if (url.pathname === "/api/alerts") {
        expect(query.get("max-results")).toBe("100");
        expect(Number(query.get("start-index"))).toBeGreaterThanOrEqual(0);
      }
    }
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
    const firstQuery = new URL(firstDiscovery!.url).searchParams;
    expect(Date.parse(firstQuery.get("until")!) - Date.parse(firstQuery.get("from")!))
      .toBe(CANARY_RERUN_LOOKBACK_MS);
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
    const firstQuery = new URL(firstDiscovery!.url).searchParams;
    expect(Date.parse(firstQuery.get("until")!) - Date.parse(firstQuery.get("from")!))
      .toBe(CANARY_RERUN_LOOKBACK_MS);
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

  test("a cleaned handoff still performs an idempotent terminal inventory sweep", async () => {
    const service = canaryService();
    await verifyIlertWebhookCanary({ ...canaryOptions, fetchFn: service.fetchFn });
    const eventCount = service.events.length;
    await finalizeIlertWebhookCanary({
      ...canaryOptions,
      alertSubmitted: "cleaned",
      fetchFn: service.fetchFn,
      ...finalizerTiming(),
    });
    expect(service.events).toHaveLength(eventCount);
    expect(service.alertListRequests).toBeGreaterThan(0);
  });

  test("a cleaned handoff resolves a delayed duplicate after a retry-ambiguous ALERT", async () => {
    let currentTime = 0;
    const service = canaryService({
      deferFirstAlertCreation: true,
      releaseDeferredAlertAfterResolved: true,
    });
    let firstAlertResponseLost = true;
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await service.fetchFn(input, init);
      if (firstAlertResponseLost && request.method === "POST" && request.url.endsWith("/events")) {
        firstAlertResponseLost = false;
        throw new Error("connection reset after Event API acceptance");
      }
      return response;
    };

    await verifyIlertWebhookCanary({
      ...canaryOptions,
      fetchFn,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    expect(service.events.filter((event) => event.eventType === "ALERT")).toHaveLength(2);
    expect(service.statuses).toEqual(["RESOLVED"]);

    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      alertSubmitted: "cleaned",
      fetchFn,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });

    expect(service.alertListRequests).toBeGreaterThan(1);
    expect(service.requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/100/resolve")
    )).toBe(true);
    expect(service.statuses).toEqual(["RESOLVED", "RESOLVED"]);
    expect(service.events.filter((event) => event.eventType === "ALERT")).toHaveLength(2);
  });

  test("observes a stale open-state read after an accepted RESOLVE", async () => {
    const service = canaryService({ existing: true, staleOpenReadsAfterResolve: 2 });
    await finalizeIlertWebhookCanary({ ...finalizerOptions(), fetchFn: service.fetchFn });
    expect(service.requests.filter((request) => request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")).length).toBeGreaterThanOrEqual(1);
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
      expect(
        service.events.some((event) => event.eventType === "RESOLVE") ||
        service.requests.some((request) =>
          request.method === "PUT" && /\/alerts\/[1-9][0-9]*\/resolve$/u.test(new URL(request.url).pathname)
        ),
      ).toBe(true);
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
    expect(
      service.events.some((event) => event.eventType === "RESOLVE") ||
      service.requests.some((request) =>
        request.method === "PUT" && /\/alerts\/[1-9][0-9]*\/resolve$/u.test(new URL(request.url).pathname)
      ),
    ).toBe(true);
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
      deferredListings: 2,
      eventResolveAlwaysFails: true,
      existing: true,
      staleOpenReadsAfterResolve: 2,
    });
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      fetchFn: service.fetchFn,
    });
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

  test("uses the 32-day inventory window for an attempt older than GitHub's rerun allowance", async () => {
    const runStartedAt = 30 * 24 * 60 * 60 * 1_000 + 10 * 60 * 1_000;
    let currentTime = runStartedAt;
    let resolved = false;
    const inventoryTimes: number[] = [];
    const requests: Request[] = [];
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
      if (url.pathname === "/api/events") return new Response(null, { status: 202 });
      if (url.pathname === "/api/alerts/count") {
        return Response.json({ count: currentTime >= runStartedAt + 361_000 ? 1 : 0 });
      }
      if (url.pathname === "/api/alerts") {
        inventoryTimes.push(currentTime);
        const from = url.searchParams.get("from");
        if (url.searchParams.getAll("states").includes("RESOLVED")) {
          expect(Date.parse(from!)).toBeLessThanOrEqual(0);
        }
        return Response.json(currentTime >= runStartedAt + 361_000 ? [{
          alertKey: canaryAlertKey(RUN_ID, "1"),
          alertSource: { id: SOURCE_ID },
          id: 199,
          priority: "HIGH",
          status: resolved ? "RESOLVED" : "PENDING",
        }] : []);
      }
      if (request.method === "PUT" && url.pathname === "/api/alerts/199/resolve") {
        resolved = true;
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/api/alerts/199") {
        return Response.json({
          alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
          alertSource: { id: SOURCE_ID },
          id: 199,
          priority: "HIGH",
          status: resolved ? "RESOLVED" : "PENDING",
        });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };

    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      alertSubmitted: "cleaned",
      fetchFn,
      runAttempt: "2",
      sweepAttempt: "2",
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    expect(inventoryTimes).toContain(runStartedAt + 360_000);
    expect(inventoryTimes).toContain(runStartedAt + 365_000);
    expect(requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/199/resolve")
    )).toBe(true);
    expect(resolved).toBe(true);
  });

  test("does not post the current HIGH alert when count-backed preclean loses a shifted prior alert", async () => {
    const requests: Request[] = [];
    const unrelated = Array.from({ length: 100 }, (_, index) => ({
      alertKey: `unrelated-${index + 1}`,
      alertSource: { id: SOURCE_ID },
      id: index + 1,
      priority: "HIGH",
      status: "PENDING",
    }));
    await expect(verifyIlertWebhookCanary({
      ...canaryOptions,
      runAttempt: "2",
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.pathname === "/api/alerts/count") return Response.json({ count: 101 });
        if (url.pathname === "/api/alerts") {
          return Response.json(Number(url.searchParams.get("start-index")) === 0 ? unrelated : []);
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      },
    })).rejects.toThrow("did not stabilize prior-attempt canary cleanup");
    expect(requests.some((request) =>
      new URL(request.url).pathname === "/api/alerts/count"
    )).toBe(true);
    expect(requests.some((request) => {
      const url = new URL(request.url);
      return url.pathname === "/api/alerts" &&
        url.searchParams.getAll("states").join(",") === "PENDING,ACCEPTED,RESOLVED";
    })).toBe(true);
    expect(requests.some((request) =>
      request.method === "POST" && new URL(request.url).pathname === "/api/events"
    )).toBe(false);
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

  test("finalizer sweeps earlier attempts from a running-attempt fallback identity", async () => {
    const service = canaryService({ existing: true, status: "PENDING" });
    await runCli({
      args: ["--finalize-canary"],
      env: cliEnvironment({
        POSTIL_ILERT_CANARY_ALERT_SUBMITTED: "unknown",
        POSTIL_ILERT_CANARY_RUN_ATTEMPT: "2",
        POSTIL_ILERT_CANARY_SWEEP_ATTEMPT: "2",
      }),
      fetchFn: service.fetchFn,
      ...finalizerTiming(),
      log: () => undefined,
    });
    expect(service.requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")
    )).toBe(true);
  });

  test("excludes a large resolved history outside the bounded terminal report-time window", async () => {
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
      if (new URL(request.url).pathname === "/api/alerts/count") {
        return Response.json({ count: 0 });
      }
      if (request.url.includes("/alerts?")) {
        const query = new URL(request.url).searchParams;
        if (query.has("from")) return Response.json([]);
        const start = Number(query.get("start-index"));
        return Response.json(historical.slice(start, start + 100));
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    await finalizeIlertWebhookCanary({ ...finalizerOptions(), fetchFn });
    const alertQueries = requests.filter((request) => request.url.includes("/alerts?"));
    const terminalInventoryQueries = alertQueries.filter((request) => {
      const states = new URL(request.url).searchParams.getAll("states");
      return states.includes("PENDING") && states.includes("ACCEPTED") && states.includes("RESOLVED");
    });
    expect(terminalInventoryQueries.length).toBeGreaterThanOrEqual(2);
    expect(terminalInventoryQueries.every((request) =>
      new URL(request.url).searchParams.get("start-index") === "0"
    )).toBe(true);
    expect(terminalInventoryQueries.every((request) =>
      new URL(request.url).searchParams.has("from") && new URL(request.url).searchParams.has("until")
    )).toBe(true);
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
      ).length).toBeGreaterThanOrEqual(1);

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
      ).length).toBeGreaterThanOrEqual(1);
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

  for (const priority of ["UNKNOWN", undefined] as const) {
    test(`primary retains the exact ID after ${priority ?? "missing"} list priority`, async () => {
      let invalidListingReturned = false;
      const service = canaryService({ eventResolveAlwaysFails: true });
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
              ...(priority === undefined ? {} : { priority }),
              status: "PENDING",
            }]);
          }
          return service.fetchFn(input, init);
        },
      })).rejects.toThrow("invalid priority");
      expect(service.requests.some((request) =>
        request.method === "PUT" && request.url.endsWith("/alerts/99/resolve")
      )).toBe(true);
    });

    test(`finalizer resolves a retained ID after ${priority ?? "missing"} priority despite Event API failure`, async () => {
      let alertListings = 0;
      const service = canaryService({ existing: true, eventResolveAlwaysFails: true });
      await expect(finalizeIlertWebhookCanary({
        ...finalizerOptions(),
        alertSubmitted: "true",
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          if (request.url.includes("/alerts?")) {
            alertListings += 1;
            if (alertListings <= 2) return Response.json([]);
            if (alertListings === 3) {
              return Response.json([{
                alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
                alertSource: { id: SOURCE_ID },
                id: 98,
                ...(priority === undefined ? {} : { priority }),
                status: "PENDING",
              }]);
            }
          }
          return service.fetchFn(input, init);
        },
      })).rejects.toThrow("invalid priority");
      expect(service.requests.some((request) =>
        request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")
      )).toBe(true);
    });
  }

  for (const invalidField of ["status", "priority", "id"] as const) {
    test(`continues past an invalid attempt-1 ${invalidField} to resolve a later attempt-2 alert`, async () => {
      let invalidListingReturned = false;
      const attemptOneKey = canaryAlertKey(RUN_ID, "1");
      const attemptTwoKey = canaryAlertKey(RUN_ID, "2");
      const service = canaryService({
        initialAlerts: [
          { alertKey: attemptOneKey, id: 98, priority: "HIGH", status: "PENDING" },
          { alertKey: attemptTwoKey, id: 99, priority: "HIGH", status: "PENDING" },
        ],
      });
      await expect(finalizeIlertWebhookCanary({
        ...finalizerOptions(),
        runAttempt: "3",
        sweepAttempt: "3",
        fetchFn: async (input, init) => {
          const request = new Request(input, init);
          if (!invalidListingReturned && request.url.includes("/alerts?")) {
            invalidListingReturned = true;
            return Response.json([
              {
                alertKey: attemptOneKey,
                alertSource: { id: SOURCE_ID },
                ...(invalidField === "id" ? {} : { id: 98 }),
                priority: invalidField === "priority" ? "UNKNOWN" : "HIGH",
                status: invalidField === "status" ? "UNKNOWN" : "PENDING",
              },
              {
                alertKey: attemptTwoKey,
                alertSource: { id: SOURCE_ID },
                id: 99,
                priority: "HIGH",
                status: "PENDING",
              },
            ]);
          }
          return service.fetchFn(input, init);
        },
      })).rejects.toThrow(
        invalidField === "id"
          ? "without an identity"
          : `invalid ${invalidField}`,
      );
      for (const id of invalidField === "status" || invalidField === "priority"
        ? ["98", "99"]
        : ["99"]) {
        expect(service.requests.some((request) =>
          request.method === "PUT" && request.url.endsWith(`/alerts/${id}/resolve`)
        )).toBe(true);
      }
    });
  }

  for (const alertSource of [undefined, { id: SOURCE_ID + 1 }] as const) {
    test(`does not resolve a matching alert with a ${alertSource ? "mismatched" : "missing"} source while later trusted alerts clean`, async () => {
      const requests: Request[] = [];
      let currentTime = 0;
      let trustedResolved = false;
      const untrustedId = 98;
      const trustedId = 99;
      const attemptOneKey = canaryAlertKey(RUN_ID, "1");
      const attemptTwoKey = canaryAlertKey(RUN_ID, "2");
      const fetchFn: Fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
        if (url.pathname === "/api/alerts/count") return Response.json({ count: 2 });
        if (url.pathname === "/api/alerts") {
          return Response.json([
            {
              alertKey: attemptOneKey,
              ...(alertSource ? { alertSource } : {}),
              id: untrustedId,
              priority: "HIGH",
              status: "PENDING",
            },
            {
              alertKey: attemptTwoKey,
              alertSource: { id: SOURCE_ID },
              id: trustedId,
              priority: "HIGH",
              status: trustedResolved ? "RESOLVED" : "PENDING",
            },
          ]);
        }
        if (request.method === "PUT" && url.pathname === `/api/alerts/${trustedId}/resolve`) {
          trustedResolved = true;
          return new Response(null, { status: 200 });
        }
        if (url.pathname === `/api/alerts/${trustedId}`) {
          return Response.json({
            alertKey: attemptTwoKey,
            alertSource: { id: SOURCE_ID },
            id: trustedId,
            priority: "HIGH",
            status: trustedResolved ? "RESOLVED" : "PENDING",
          });
        }
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      };

      await expect(finalizeIlertWebhookCanary({
        ...finalizerOptions(),
        alertSubmitted: "cleaned",
        fetchFn,
        runAttempt: "3",
        sweepAttempt: "3",
        now: () => currentTime,
        sleep: async (milliseconds) => { currentTime += milliseconds; },
      })).rejects.toThrow(alertSource ? "different source" : "without a valid source");
      expect(requests.some((request) =>
        request.method === "PUT" && request.url.endsWith(`/alerts/${untrustedId}/resolve`)
      )).toBe(false);
      expect(requests.some((request) =>
        request.method === "PUT" && request.url.endsWith(`/alerts/${trustedId}/resolve`)
      )).toBe(true);
      expect(trustedResolved).toBe(true);
    });
  }

  test("recovers from one incomplete terminal inventory after two complete empty scans", async () => {
    let currentTime = 0;
    let terminalFailures = 3;
    const service = canaryService();
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      alertSubmitted: "unknown",
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        if (
          request.url.includes("/alerts?") &&
          currentTime >= 360_000 &&
          terminalFailures > 0
        ) {
          terminalFailures -= 1;
          return new Response(null, { status: 503 });
        }
        return service.fetchFn(input, init);
      },
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    expect(terminalFailures).toBe(0);
    expect(currentTime).toBeGreaterThanOrEqual(370_000);
  });

  test("requires matching all-state counts and repeated inventories before terminal success", async () => {
    let currentTime = 0;
    let terminalCountCalls = 0;
    const service = canaryService();
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      alertSubmitted: "cleaned",
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/alerts/count" && currentTime >= 360_000) {
          terminalCountCalls += 1;
          if (terminalCountCalls === 2) return Response.json({ count: 1 });
        }
        return service.fetchFn(input, init);
      },
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    expect(terminalCountCalls).toBeGreaterThanOrEqual(6);
    const terminalLists = service.requests.filter((request) => {
      const url = new URL(request.url);
      return url.pathname === "/api/alerts" &&
        url.searchParams.getAll("states").join(",") === "PENDING,ACCEPTED,RESOLVED";
    });
    expect(terminalLists.length).toBeGreaterThanOrEqual(4);
  });

  test("retains a late-page canary when continuity revalidation observes churn", async () => {
    let currentTime = 0;
    let terminalLists = 0;
    let resolved = false;
    const canaryId = 202;
    const baseline = Array.from({ length: 100 }, (_, index) => ({
      alertKey: `unrelated-${index + 1}`,
      alertSource: { id: SOURCE_ID },
      id: index + 1,
      priority: "HIGH",
      status: "RESOLVED",
    }));
    const fetchFn: Fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/alert-sources/")) return Response.json(SOURCE);
      if (url.pathname === "/api/alerts/count") return Response.json({ count: 101 });
      if (request.method === "PUT" && url.pathname === `/api/alerts/${canaryId}/resolve`) {
        resolved = true;
        return new Response(null, { status: 200 });
      }
      if (url.pathname === `/api/alerts/${canaryId}`) {
        return Response.json({
          alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
          alertSource: { id: SOURCE_ID },
          id: canaryId,
          priority: "HIGH",
          status: resolved ? "RESOLVED" : "PENDING",
        });
      }
      if (url.pathname === "/api/alerts") {
        const states = url.searchParams.getAll("states");
        if (!states.includes("RESOLVED")) return Response.json([]);
        terminalLists += 1;
        const start = Number(url.searchParams.get("start-index"));
        if (start === 0) return Response.json(baseline);
        const churned = terminalLists === 4;
        if (churned || resolved) {
          return Response.json([{
            alertKey: canaryAlertKey(RUN_ID, RUN_ATTEMPT),
            alertSource: { id: SOURCE_ID },
            id: canaryId,
            priority: "HIGH",
            status: resolved ? "RESOLVED" : "PENDING",
          }]);
        }
        return Response.json([{
          alertKey: "unrelated-101",
          alertSource: { id: SOURCE_ID },
          id: 101,
          priority: "HIGH",
          status: "RESOLVED",
        }]);
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };
    await finalizeIlertWebhookCanary({
      ...finalizerOptions(),
      alertSubmitted: "cleaned",
      fetchFn,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });
    expect(terminalLists).toBeGreaterThanOrEqual(8);
    expect(resolved).toBe(true);
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

  test("cleaned finalizer CLI loads credentials and performs management cleanup", async () => {
    const service = canaryService();
    await runCli({
      args: ["--finalize-canary"],
      env: cliEnvironment({ POSTIL_ILERT_CANARY_ALERT_SUBMITTED: "cleaned" }),
      fetchFn: service.fetchFn,
      ...finalizerTiming(),
      log: () => undefined,
    });
    expect(service.alertListRequests).toBeGreaterThan(0);
    expect(service.events).toEqual([]);
  });

  test("orphan sweep CLI requires only scoped management cleanup inputs", async () => {
    const service = canaryService({
      initialAlerts: [{
        alertKey: canaryAlertKey("67890", "2"),
        id: 98,
        status: "PENDING",
      }],
    });
    await runCli({
      args: ["--sweep-canary-orphans"],
      env: {
        ILERT_API_KEY: API_KEY,
        POSTIL_ILERT_ALERT_SOURCE_ID: String(SOURCE_ID),
      },
      fetchFn: service.fetchFn,
      now: () => 0,
      sleep: async () => undefined,
      log: () => undefined,
    });
    expect(service.events).toEqual([]);
    expect(service.requests.some((request) =>
      request.method === "PUT" && request.url.endsWith("/alerts/98/resolve")
    )).toBe(true);
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
  };
}

function canaryService(options: {
  alertReportTime?: string;
  alertRetryAfter?: string;
  deduplicateAlertKeys?: boolean;
  deferFirstAlertCreation?: boolean;
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
  releaseDeferredAlertAfterResolved?: boolean;
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
  let deferredAlert: { alertKey: string; priority: "HIGH" | "LOW"; reportTime?: string } | undefined;
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
        options.deferFirstAlertCreation &&
        !deferredAlert
      ) {
        deferredAlert = {
          alertKey: body.alertKey,
          priority: options.mainPriority ?? body.priority ?? "HIGH",
          reportTime: options.alertReportTime,
        };
      } else if (
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
    if (new URL(request.url).pathname === "/api/alerts/count") {
      const query = new URL(request.url).searchParams;
      const states = query.getAll("states");
      const from = query.get("from");
      const source = query.get("sources");
      const until = query.get("until");
      const count = alerts.filter((alert) => {
        if (alert.reportTime && ((from && alert.reportTime < from) || (until && alert.reportTime > until))) return false;
        if (source && source !== String(alert.sourceId)) return false;
        return states.length === 0 || states.includes(alert.status);
      }).length;
      return Response.json({ count });
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
      if (
        deferredAlert &&
        options.releaseDeferredAlertAfterResolved &&
        alerts.length > 0 &&
        alerts.every((alert) => alert.status === "RESOLVED")
      ) {
        const id = Math.max(...alerts.map((alert) => alert.id)) + 1;
        alerts.push({
          alertKey: deferredAlert.alertKey,
          createdReceived: true,
          id,
          priority: deferredAlert.priority,
          reportTime: deferredAlert.reportTime,
          resolvedReceived: false,
          sourceId: SOURCE_ID,
          status: "PENDING",
        });
        deferredAlert = undefined;
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
  const actionInventory = new Map<string, Response>();
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    const actionList = url.pathname === "/api/alert-actions";
    if (url.pathname.startsWith("/api/alert-actions") && request.method !== "GET") {
      actionInventory.clear();
    }
    const cached = actionList ? actionInventory.get(request.url) : undefined;
    if (cached) return cached.clone();
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    if (actionList) actionInventory.set(request.url, response.clone());
    return response;
  };
}

function errorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (typeof error === "string") return [error];
  if (!error || typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.flatMap((nested) => errorMessages(nested, seen)),
    ];
  }
  if (error instanceof Error) {
    return [error.message, ...errorMessages(error.cause, seen)];
  }
  return [];
}
