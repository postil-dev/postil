import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core/dialect";

import {
  configuredIlertWebhookSecret,
  formatIlertAlertSseEvent,
  hasIlertCanaryAlertEvent,
  ILERT_WEBHOOK_MAX_BODY_BYTES,
  ILERT_WEBHOOK_USERNAME,
  ilertAlertStreamDatabaseUrl,
  isApplicationJson,
  isIlertCanaryAlertKey,
  parseIlertLastEventId,
  parseIlertWebhookBody,
  verifyIlertWebhookAuthorization,
  type StoredIlertAlertEvent,
} from "@/lib/ilert-alerts";

const ORIGINAL_WEBHOOK_SECRET = process.env.POSTIL_ILERT_WEBHOOK_SECRET;
const TEST_WEBHOOK_SECRET = "test-ilert-webhook-password-32-bytes";
const TEST_CANARY_KEY = "postil-ilert-webhook-canary-123456789-2";
let observationResult: () => Promise<Array<{ sequence: bigint }>> = async () => [];

mock.module("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: observationResult }),
      }),
    }),
  }),
}));

mock.module("@/lib/server-observability", () => ({
  reportOperationalFailure: () => undefined,
}));

afterEach(() => {
  observationResult = async () => [];
  if (ORIGINAL_WEBHOOK_SECRET === undefined) {
    delete process.env.POSTIL_ILERT_WEBHOOK_SECRET;
  } else {
    process.env.POSTIL_ILERT_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET;
  }
});

describe("iLert webhook input", () => {
  test("treats absent and weak secrets as unconfigured", () => {
    expect(configuredIlertWebhookSecret(undefined)).toBeNull();
    expect(configuredIlertWebhookSecret("x".repeat(31))).toBeNull();
    expect(configuredIlertWebhookSecret("x".repeat(32))).toBeNull();
    expect(configuredIlertWebhookSecret("0123456789abcdef".repeat(2))).toBe(
      "0123456789abcdef".repeat(2),
    );
    expect(configuredIlertWebhookSecret(`x${"y".repeat(31)}\0`)).toBeNull();
    expect(configuredIlertWebhookSecret("x".repeat(513))).toBeNull();
  });

  test("requires canonical Basic credentials with the fixed username", () => {
    expect(
      verifyIlertWebhookAuthorization(
        basicAuthorization(ILERT_WEBHOOK_USERNAME, TEST_WEBHOOK_SECRET),
        TEST_WEBHOOK_SECRET,
      ),
    ).toBe(true);
    expect(
      verifyIlertWebhookAuthorization(
        basicAuthorization("operator", TEST_WEBHOOK_SECRET),
        TEST_WEBHOOK_SECRET,
      ),
    ).toBe(false);
    expect(
      verifyIlertWebhookAuthorization(
        basicAuthorization(ILERT_WEBHOOK_USERNAME, `${TEST_WEBHOOK_SECRET}x`),
        TEST_WEBHOOK_SECRET,
      ),
    ).toBe(false);
    expect(verifyIlertWebhookAuthorization("Basic !!!", TEST_WEBHOOK_SECRET)).toBe(
      false,
    );
    expect(verifyIlertWebhookAuthorization(null, TEST_WEBHOOK_SECRET)).toBe(false);
  });

  test("accepts only application/json media types", () => {
    expect(isApplicationJson("application/json")).toBe(true);
    expect(isApplicationJson("Application/JSON; charset=utf-8")).toBe(true);
    expect(isApplicationJson("application/problem+json")).toBe(false);
    expect(isApplicationJson("text/plain")).toBe(false);
    expect(isApplicationJson(null)).toBe(false);
  });

  test("accepts only exact attempt-specific canary keys", () => {
    expect(isIlertCanaryAlertKey(TEST_CANARY_KEY)).toBe(true);
    expect(isIlertCanaryAlertKey("postil-ilert-webhook-canary-123456789-51")).toBe(true);
    expect(isIlertCanaryAlertKey("routine-alert-key")).toBe(false);
    expect(isIlertCanaryAlertKey("postil-ilert-webhook-canary-123456789-52")).toBe(false);
    expect(isIlertCanaryAlertKey("postil-ilert-webhook-canary-9999999999999999-1")).toBe(false);
  });

  test("accepts bounded official alert extensions and rejects non-alert events", () => {
    expect(parseIlertWebhookBody(eventBody())).toMatchObject({
      id: "12797430",
      eventType: "alert-created",
      eventId: "7b21f505-bd0f-49a2-bf8f-f238919b23fc",
    });

    const withUnknownField = eventFixture() as Record<string, unknown>;
    withUnknownField.customDetails = { executable: "ignored" };
    expect(parseIlertWebhookBody(jsonBody(withUnknownField))).toMatchObject({
      id: "12797430",
      eventType: "alert-created",
    });

    const incident = eventFixture();
    incident.eventType = "incident-created";
    expect(parseIlertWebhookBody(jsonBody(incident))).toBeNull();

  });

  test("accepts the configured creation, escalation, raised, and lifecycle events", () => {
    for (const eventType of [
      "alert-created",
      "alert-assigned",
      "alert-auto-escalated",
      "alert-auto-resolved",
      "alert-acknowledged",
      "alert-rejected",
      "alert-raised",
      "alert-comment-added",
      "alert-resolved",
      "alert-snoozed",
    ] as const) {
      const event = eventFixture();
      event.eventType = eventType;
      expect(parseIlertWebhookBody(jsonBody(event))?.eventType).toBe(eventType);
    }
  });

  test("rejects malformed identifiers, timestamps, nesting, and string bounds", () => {
    const mutations: Array<(value: ReturnType<typeof eventFixture>) => void> = [
      (value) => {
        value.id = "0";
      },
      (value) => {
        value.eventId = "not-a-uuid";
      },
      (value) => {
        value.timestamp = "2026-08-26";
      },
      (value) => {
        value.summary = "x".repeat(513);
      },
      (value) => {
        value.details = "x".repeat(8_193);
      },
      (value) => {
        value.alertSource.name = "x".repeat(257);
      },
      (value) => {
        value.priority = "CRITICAL";
      },
    ];
    for (const mutate of mutations) {
      const value = eventFixture();
      mutate(value);
      expect(parseIlertWebhookBody(jsonBody(value))).toBeNull();
    }
    expect(parseIlertWebhookBody(Buffer.from([0xc3, 0x28]))).toBeNull();
  });

  test("the route applies auth, media type, schema, and body bounds before storage", async () => {
    const { POST } = await import("@/app/api/webhooks/ilert/route");

    delete process.env.POSTIL_ILERT_WEBHOOK_SECRET;
    expect(await POST(webhookRequest(eventBody()))).toHaveProperty("status", 404);

    process.env.POSTIL_ILERT_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    expect(
      await POST(webhookRequest(eventBody(), { authorization: "Basic invalid" })),
    ).toHaveProperty("status", 401);
    expect(
      await POST(
        webhookRequest(eventBody(), {
          authorization: validAuthorization(),
          contentType: "text/plain",
        }),
      ),
    ).toHaveProperty("status", 415);
    expect(
      await POST(
        webhookRequest(Buffer.from("{}"), {
          authorization: validAuthorization(),
        }),
      ),
    ).toHaveProperty("status", 400);
    expect(
      await POST(
        webhookRequest(Buffer.alloc(ILERT_WEBHOOK_MAX_BODY_BYTES + 1), {
          authorization: validAuthorization(),
        }),
      ),
    ).toHaveProperty("status", 413);
  });

  test("the route preflights receiver credentials without reading alert state", async () => {
    const { GET } = await import("@/app/api/webhooks/ilert/route");
    process.env.POSTIL_ILERT_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

    expect(await GET(new Request("https://postil.dev/api/webhooks/ilert"))).toHaveProperty(
      "status",
      401,
    );
    expect(await GET(new Request("https://postil.dev/api/webhooks/ilert", {
      headers: { authorization: validAuthorization() },
    }))).toHaveProperty("status", 204);
    expect(await GET(new Request(
      "https://postil.dev/api/webhooks/ilert?alertId=1&eventType=alert-comment-added&sourceId=2",
      { headers: { authorization: validAuthorization() } },
    ))).toHaveProperty("status", 400);
    expect(await GET(new Request(
      "https://postil.dev/api/webhooks/ilert?alertKey=routine-alert&eventType=alert-created&sourceId=2",
      { headers: { authorization: validAuthorization() } },
    ))).toHaveProperty("status", 400);
  });

  test("the route returns an authenticated exact receiver-event observation", async () => {
    const { GET } = await import("@/app/api/webhooks/ilert/route");
    process.env.POSTIL_ILERT_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    observationResult = async () => [{ sequence: 1n }];

    const response = await GET(new Request(
      `https://postil.dev/api/webhooks/ilert?alertKey=${TEST_CANARY_KEY}&eventType=alert-created&sourceId=2269078`,
      { headers: { authorization: validAuthorization() } },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ received: true });
  });

  test("the route returns 503 when the receiver-event read fails", async () => {
    const { GET } = await import("@/app/api/webhooks/ilert/route");
    process.env.POSTIL_ILERT_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    observationResult = async () => {
      throw new Error("database unavailable");
    };

    const response = await GET(new Request(
      `https://postil.dev/api/webhooks/ilert?alertKey=${TEST_CANARY_KEY}&eventType=alert-resolved&sourceId=2269078`,
      { headers: { authorization: validAuthorization() } },
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "webhook observation unavailable" });
  });
});

describe("iLert operator stream protocol", () => {
  test("checks exact canary key, event type, and source persistence", async () => {
    const events = [
      { alertKey: TEST_CANARY_KEY, eventType: "alert-resolved", alertSourceId: 2269078n, sequence: 1n },
      { alertKey: "postil-ilert-webhook-canary-123456790-2", eventType: "alert-resolved", alertSourceId: 2269078n, sequence: 2n },
      { alertKey: TEST_CANARY_KEY, eventType: "alert-created", alertSourceId: 2269079n, sequence: 3n },
      { alertKey: TEST_CANARY_KEY, eventType: "alert-resolved", alertSourceId: 2269079n, sequence: 4n },
    ];
    const dialect = new PgDialect();
    const expectedPredicates = [
      [TEST_CANARY_KEY, "alert-resolved", 2269078n],
      [TEST_CANARY_KEY, "alert-created", 2269078n],
    ];
    let predicateCalls = 0;
    const db = {
      select() {
        return {
          from: () => ({
            where: (predicate: SQL) => ({
              limit: async () => {
                const query = dialect.sqlToQuery(predicate);
                expect(query.sql).toContain('"ilert_alert_events"."alert_key" = $1');
                expect(query.sql).not.toContain('"ilert_alert_events"."alert_id"');
                expect(query.sql).toContain('"ilert_alert_events"."event_type" = $2');
                expect(query.sql).toContain('"ilert_alert_events"."alert_source_id" = $3');
                const [alertKey, eventType, alertSourceId] = query.params;
                expect([alertKey, eventType, alertSourceId]).toEqual(
                  expectedPredicates[predicateCalls++]!,
                );
                return events
                  .filter((event) =>
                    event.alertKey === alertKey &&
                    event.eventType === eventType &&
                    event.alertSourceId === alertSourceId
                  )
                  .map(({ sequence }) => ({ sequence }));
              },
            }),
          }),
        };
      },
    } as never;
    expect(await hasIlertCanaryAlertEvent(db, TEST_CANARY_KEY, "alert-resolved", 2269078n)).toBe(true);
    expect(await hasIlertCanaryAlertEvent(db, TEST_CANARY_KEY, "alert-created", 2269078n)).toBe(false);
  });

  test("stages the receiver secret and operator allowlist in managed deployments", async () => {
    const deploy = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "deploy.yml"),
      "utf8",
    );
    const operatorSecrets = deploy.match(
      /operator_secret_names=\(([\s\S]*?)\n\s*\)/u,
    )?.[1];
    expect(operatorSecrets).toContain("POSTIL_ILERT_WEBHOOK_SECRET");
    expect(operatorSecrets).toContain("POSTIL_OPERATOR_GITHUB_IDS");
    expect(deploy).not.toContain(
      "POSTIL_ILERT_WEBHOOK_SECRET: ${{ secrets.POSTIL_ILERT_WEBHOOK_SECRET }}",
    );
    expect(deploy).toContain(
      "POSTIL_OPERATOR_GITHUB_IDS: ${{ secrets.POSTIL_OPERATOR_GITHUB_IDS }}",
    );
  });

  test("uses a session endpoint for Supabase LISTEN connections", () => {
    expect(ilertAlertStreamDatabaseUrl(
      "postgresql://user:password@aws-0-eu.pooler.supabase.com:6543/postgres?pgbouncer=true",
    )).toBe(
      "postgresql://user:password@aws-0-eu.pooler.supabase.com:5432/postgres",
    );
    expect(ilertAlertStreamDatabaseUrl(
      "postgresql://user:password@database.internal:5432/postil",
    )).toBe("postgresql://user:password@database.internal:5432/postil");
    expect(() => ilertAlertStreamDatabaseUrl(
      "postgresql://user:password@unknown.example:6543/postil",
    )).toThrow("requires a session-capable database endpoint");
  });

  test("parses only bounded PostgreSQL sequence cursors", () => {
    expect(parseIlertLastEventId(null)).toBe(0n);
    expect(parseIlertLastEventId("")).toBe(0n);
    expect(parseIlertLastEventId("42")).toBe(42n);
    expect(parseIlertLastEventId("-1")).toBeNull();
    expect(parseIlertLastEventId("01")).toBeNull();
    expect(parseIlertLastEventId("9223372036854775808")).toBeNull();
  });

  test("formats one bounded JSON data line without SSE field injection", () => {
    const event = storedEvent({
      summary: "line one\n\nid: injected",
      details: "event: injected\ndata: still-json",
    });
    const output = formatIlertAlertSseEvent(event);
    expect(output.split("\n")).toHaveLength(5);
    expect(output).toStartWith("id: 1\nevent: alert-created\ndata: {");
    expect(output).not.toContain("\nid: injected");
    expect(output).not.toContain("\nevent: injected");
    expect(JSON.parse(output.split("\n")[2]!.slice("data: ".length))).toMatchObject(
      { summary: "line one\n\nid: injected" },
    );
  });

  test("contains no outbound iLert API call or periodic alert-state query", async () => {
    const root = join(import.meta.dir, "..");
    const [library, webhookRoute, streamRoute] = await Promise.all([
      readFile(join(root, "src/lib/ilert-alerts.ts"), "utf8"),
      readFile(join(root, "src/app/api/webhooks/ilert/route.ts"), "utf8"),
      readFile(join(root, "src/app/api/operator/alerts/stream/route.ts"), "utf8"),
    ]);
    const integration = `${library}\n${webhookRoute}\n${streamRoute}`;
    expect(integration).not.toContain("api.ilert.com");
    expect(integration).not.toMatch(/\bfetch\s*\(/u);
    expect(integration).not.toMatch(/\bconsole\./u);
    expect(integration).not.toMatch(/\b(?:ACCEPT|ACK|RESOLVE)\b/u);

    const keepalive = streamRoute.match(
      /keepalive = setInterval\(\(\) => \{([\s\S]*?)\n\s*\}, ILERT_ALERT_STREAM_KEEPALIVE_MS\);/u,
    );
    expect(keepalive).not.toBeNull();
    expect(keepalive?.[1]).not.toMatch(
      /(?:getDb|getIlertAlertEvent|replayIlertAlertEvents|\.query\s*\()/u,
    );
  });
});

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function validAuthorization(): string {
  return basicAuthorization(ILERT_WEBHOOK_USERNAME, TEST_WEBHOOK_SECRET);
}

function webhookRequest(
  body: Buffer,
  options: { authorization?: string; contentType?: string } = {},
): Request {
  return new Request("https://postil.dev/api/webhooks/ilert", {
    method: "POST",
    headers: {
      authorization: options.authorization ?? validAuthorization(),
      "content-type": options.contentType ?? "application/json",
    },
    body: Uint8Array.from(body),
  });
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function eventBody(): Buffer {
  return jsonBody(eventFixture());
}

function eventFixture() {
  return {
    id: "12797430",
    summary: "Test alert summary",
    details: "Some test details",
    reportTime: "2026-08-26T10:37:51.829Z",
    status: "PENDING",
    eventType: "alert-created",
    priority: "HIGH",
    alertSource: { id: 2269078, name: "Postil production" },
    timestamp: "2026-08-26T10:37:51.838605470Z",
    eventId: "7b21f505-bd0f-49a2-bf8f-f238919b23fc",
    correlationId: "8b21f505-bd1f-49a2-bf8f-f246519b23fc",
    escalationPolicy: { id: 2256025, name: "Default escalation" },
    mergeState: "NONE",
    comment: undefined as string | undefined,
  };
}

function storedEvent(
  overrides: Partial<StoredIlertAlertEvent> = {},
): StoredIlertAlertEvent {
  return {
    sequence: 1n,
    eventId: "7b21f505-bd0f-49a2-bf8f-f238919b23fc",
    alertId: "12797430",
    alertKey: null,
    eventType: "alert-created",
    status: "PENDING",
    priority: "HIGH",
    summary: "Test alert summary",
    details: "Some test details",
    alertSourceId: 2269078n,
    alertSourceName: "Postil production",
    reportTime: new Date("2026-08-26T10:37:51.829Z"),
    occurredAt: new Date("2026-08-26T10:37:51.838Z"),
    payloadSha256: "a".repeat(64),
    receivedAt: new Date("2026-08-26T10:37:52.000Z"),
    ...overrides,
  };
}
