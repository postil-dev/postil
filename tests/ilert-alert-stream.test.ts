import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, type Notification, type Pool } from "pg";

import { closeDb, schema, type Database } from "@/lib/db";
import {
  authorizeIlertAlertStream,
  ILERT_ALERT_NOTIFY_CHANNEL,
  ILERT_WEBHOOK_USERNAME,
  replayIlertAlertEvents,
} from "@/lib/ilert-alerts";
import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const describeDb = process.env.POSTIL_TEST_DATABASE_URL ? describe : describe.skip;
const TEST_WEBHOOK_SECRET = "test-ilert-webhook-password-32-bytes";
const OPERATOR_GITHUB_ID = 991_001;
const CUSTOMER_ADMIN_GITHUB_ID = 991_002;
const OPERATOR_TOKEN = `pcli_${"a".repeat(43)}`;
const CUSTOMER_ADMIN_TOKEN = `pcli_${"b".repeat(43)}`;
const LEGACY_OPERATOR_TOKEN = `pcli_${"c".repeat(43)}`;
const ROTATING_OPERATOR_TOKEN = `pcli_${"d".repeat(43)}`;

describeDb("iLert durable operator alert stream", () => {
  let ephemeral: EphemeralDatabase;
  let pool: Pool;
  let db: Database;
  let operatorUserId: number;
  let operatorOrgId: number;
  let sequence = 0n;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalOperatorIds = process.env.POSTIL_OPERATOR_GITHUB_IDS;
  const originalWebhookSecret = process.env.POSTIL_ILERT_WEBHOOK_SECRET;

  beforeAll(async () => {
    ephemeral = await createEphemeralDatabase("ilert_alert_stream");
    pool = ephemeral.pool;
    db = drizzle(pool, { schema });
    process.env.DATABASE_URL = ephemeral.url;
    process.env.POSTIL_OPERATOR_GITHUB_IDS = String(OPERATOR_GITHUB_ID);
    process.env.POSTIL_ILERT_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

    const operator = await pool.query<{ id: string }>(
      `INSERT INTO users (github_id, login)
       VALUES ($1, 'operator') RETURNING id`,
      [OPERATOR_GITHUB_ID],
    );
    const customerAdmin = await pool.query<{ id: string }>(
      `INSERT INTO users (github_id, login)
       VALUES ($1, 'customer-admin') RETURNING id`,
      [CUSTOMER_ADMIN_GITHUB_ID],
    );
    operatorUserId = Number(operator.rows[0]!.id);
    const customerAdminUserId = Number(customerAdmin.rows[0]!.id);

    const operatorOrg = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ('operator-org', 'Operator Org') RETURNING id`,
    );
    const customerOrg = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ('customer-org', 'Customer Org') RETURNING id`,
    );
    operatorOrgId = Number(operatorOrg.rows[0]!.id);
    const customerOrgId = Number(customerOrg.rows[0]!.id);
    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($3, $4, 'admin')`,
      [operatorOrgId, operatorUserId, customerOrgId, customerAdminUserId],
    );

    await insertRenewableCliToken(
      pool,
      OPERATOR_TOKEN,
      operatorUserId,
      operatorOrgId,
    );
    await insertRenewableCliToken(
      pool,
      CUSTOMER_ADMIN_TOKEN,
      customerAdminUserId,
      customerOrgId,
    );
    await pool.query(
      `INSERT INTO cli_tokens
         (token_sha256, user_id, org_id, scope, expires_at)
       VALUES ($1, $2, $3, 'inference', now() + interval '1 hour')`,
      [sha256(LEGACY_OPERATOR_TOKEN), operatorUserId, operatorOrgId],
    );
  }, 30_000);

  afterAll(async () => {
    await closeDb();
    await ephemeral?.drop();
    restoreEnvironment("DATABASE_URL", originalDatabaseUrl);
    restoreEnvironment("POSTIL_OPERATOR_GITHUB_IDS", originalOperatorIds);
    restoreEnvironment("POSTIL_ILERT_WEBHOOK_SECRET", originalWebhookSecret);
  }, 30_000);

  test("deduplicates event ids and notifies only after the row commits", async () => {
    const listener = new Client({ connectionString: ephemeral.url });
    await listener.connect();
    await listener.query(`LISTEN ${ILERT_ALERT_NOTIFY_CHANNEL}`);
    const notification = nextNotification(listener);

    const first = await postWebhook(eventFixture({ eventType: "alert-created" }));
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      duplicate: boolean;
      sequence: string;
    };
    expect(firstBody.duplicate).toBe(false);
    sequence = BigInt(firstBody.sequence);

    const delivered = await notification;
    expect(delivered.channel).toBe(ILERT_ALERT_NOTIFY_CHANNEL);
    expect(delivered.payload).toBe(firstBody.sequence);
    const committed = await pool.query<{ payload_sha256: string }>(
      `SELECT payload_sha256 FROM ilert_alert_events WHERE sequence = $1`,
      [firstBody.sequence],
    );
    expect(committed.rows).toHaveLength(1);
    expect(committed.rows[0]?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);

    let duplicateNotifications = 0;
    const countDuplicate = () => {
      duplicateNotifications += 1;
    };
    listener.on("notification", countDuplicate);
    const duplicate = await postWebhook(eventFixture({ eventType: "alert-created" }));
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      sequence: null,
    });
    await Bun.sleep(50);
    expect(duplicateNotifications).toBe(0);
    listener.off("notification", countDuplicate);
    await listener.end();

    const replay = await replayIlertAlertEvents(db, 0n);
    expect(replay.overflow).toBe(false);
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({
      sequence,
      eventId: "7b21f505-bd0f-49a2-bf8f-f238919b23fc",
      alertId: "12797430",
    });
  });

  test("requires both a renewable CLI token and the operator GitHub allowlist", async () => {
    expect(
      await authorizeIlertAlertStream(db, `Bearer ${OPERATOR_TOKEN}`),
    ).toMatchObject({ status: "authorized", expiresAt: expect.any(Date) });
    expect(
      await authorizeIlertAlertStream(db, `Bearer ${CUSTOMER_ADMIN_TOKEN}`),
    ).toEqual({ status: "not_found" });
    expect(
      await authorizeIlertAlertStream(db, `Bearer ${LEGACY_OPERATOR_TOKEN}`),
    ).toEqual({ status: "unauthorized" });
    expect(await authorizeIlertAlertStream(db, null)).toEqual({
      status: "unauthorized",
    });
  });

  test("returns safe route failures for missing, customer-admin, and legacy credentials", async () => {
    const { GET } = await import("@/app/api/operator/alerts/stream/route");
    expect(await GET(streamRequest())).toHaveProperty("status", 401);
    expect(
      await GET(streamRequest({ token: CUSTOMER_ADMIN_TOKEN })),
    ).toHaveProperty("status", 404);
    expect(
      await GET(streamRequest({ token: LEGACY_OPERATOR_TOKEN })),
    ).toHaveProperty("status", 401);
    expect(
      await GET(streamRequest({ token: OPERATOR_TOKEN, lastEventId: "-1" })),
    ).toHaveProperty("status", 400);
  });

  test("replays a durable cursor, pushes LISTEN events, and releases on disconnect", async () => {
    const { GET } = await import("@/app/api/operator/alerts/stream/route");
    const abort = new AbortController();
    const response = await GET(
      streamRequest({
        token: OPERATOR_TOKEN,
        lastEventId: sequence.toString(),
        signal: abort.signal,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    const reader = response.body!.getReader();
    expect(await readUntil(reader, ": connected")).toContain(": connected");
    expect(await activeStreamConnections()).toBe(1);

    const raised = await postWebhook(
      eventFixture({
        eventType: "alert-raised",
        eventId: "f2e86760-18d4-47be-974c-c210fc6fc727",
        timestamp: "2026-08-26T10:38:51.838605470Z",
      }),
    );
    const raisedBody = (await raised.json()) as { sequence: string };
    sequence = BigInt(raisedBody.sequence);
    const pushed = await readUntil(reader, "event: alert-raised");
    expect(pushed).toContain(`id: ${raisedBody.sequence}`);
    expect(pushed).toContain("event: alert-raised");

    abort.abort();
    await reader.cancel().catch(() => undefined);
    expect(await eventuallyActiveStreamConnections(0)).toBe(0);

    const replayAbort = new AbortController();
    const replay = await GET(
      streamRequest({
        token: OPERATOR_TOKEN,
        lastEventId: (sequence - 1n).toString(),
        signal: replayAbort.signal,
      }),
    );
    const replayReader = replay.body!.getReader();
    const replayed = await readUntil(replayReader, "event: alert-raised");
    expect(replayed).toContain(`id: ${sequence.toString()}`);
    replayAbort.abort();
    await replayReader.cancel().catch(() => undefined);
    expect(await eventuallyActiveStreamConnections(0)).toBe(0);
  });

  test("marks access-expiry closes as routine cursor reconnects", async () => {
    await insertRenewableCliToken(
      pool,
      ROTATING_OPERATOR_TOKEN,
      operatorUserId,
      operatorOrgId,
      1_000,
    );
    const { GET } = await import("@/app/api/operator/alerts/stream/route");
    const response = await GET(
      streamRequest({ token: ROTATING_OPERATOR_TOKEN, lastEventId: sequence.toString() }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toEndWith(": rotate\n\n");
    expect(await eventuallyActiveStreamConnections(0)).toBe(0);
  });

  test("migration stores bounded metadata and no raw webhook body", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ilert_alert_events'
       ORDER BY column_name`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain("payload_sha256");
    expect(names).not.toContain("payload");
    expect(names).not.toContain("raw_payload");
    expect(names).not.toContain("authorization");
  });

  test("bounds each durable replay batch and closes its LISTEN connection", async () => {
    const afterSequence = sequence;
    await pool.query(
      `INSERT INTO ilert_alert_events
         (event_id, alert_id, event_type, status, priority, summary, details,
          alert_source_id, alert_source_name, report_time, occurred_at,
          payload_sha256)
       SELECT md5('ilert-replay-' || value::text)::uuid,
              (20000000 + value)::text,
              'alert-created', 'PENDING', 'HIGH',
              'Replay alert ' || value::text, '', 2269078,
              'Postil production', now(), now(), repeat('a', 64)
       FROM generate_series(1, 101) AS value`,
    );

    const replay = await replayIlertAlertEvents(db, afterSequence);
    expect(replay.events).toHaveLength(100);
    expect(replay.overflow).toBe(true);

    const { GET } = await import("@/app/api/operator/alerts/stream/route");
    const response = await GET(
      streamRequest({
        token: OPERATOR_TOKEN,
        lastEventId: afterSequence.toString(),
      }),
    );
    const output = await response.text();
    expect(output).toStartWith("retry: 100\n: replay batch\n\n");
    expect(output.match(/^id: /gmu)).toHaveLength(100);
    expect(await eventuallyActiveStreamConnections(0)).toBe(0);
  });

  async function postWebhook(
    event: ReturnType<typeof eventFixture>,
  ): Promise<Response> {
    const { POST } = await import("@/app/api/webhooks/ilert/route");
    return POST(
      new Request("https://postil.dev/api/webhooks/ilert", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(),
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      }),
    );
  }

  async function activeStreamConnections(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = 'postil-ilert-alert-stream'`,
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async function eventuallyActiveStreamConnections(expected: number): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const count = await activeStreamConnections();
      if (count === expected) return count;
      await Bun.sleep(25);
    }
    return activeStreamConnections();
  }
});

async function insertRenewableCliToken(
  pool: Pool,
  token: string,
  userId: number,
  orgId: number,
  accessMilliseconds = 60 * 60 * 1_000,
): Promise<void> {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO cli_refresh_sessions (user_id, org_id, expires_at)
     VALUES ($1, $2, now() + interval '180 days') RETURNING id`,
    [userId, orgId],
  );
  await pool.query(
    `INSERT INTO cli_tokens
       (token_sha256, user_id, org_id, scope, expires_at, refresh_session_id)
     VALUES ($1, $2, $3, 'inference', now() + ($5 * interval '1 millisecond'), $4)`,
    [sha256(token), userId, orgId, session.rows[0]!.id, accessMilliseconds],
  );
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function basicAuthorization(): string {
  return `Basic ${Buffer.from(`${ILERT_WEBHOOK_USERNAME}:${TEST_WEBHOOK_SECRET}`).toString("base64")}`;
}

function streamRequest(options: {
  token?: string;
  lastEventId?: string;
  signal?: AbortSignal;
} = {}): Request {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.lastEventId !== undefined) {
    headers.set("last-event-id", options.lastEventId);
  }
  return new Request("https://postil.dev/api/operator/alerts/stream", {
    headers,
    signal: options.signal,
  });
}

function eventFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "12797430",
    summary: "Postil production alert",
    details: "The production service needs operator attention.",
    reportTime: "2026-08-26T10:37:51.829Z",
    status: "PENDING",
    eventType: "alert-created",
    priority: "HIGH",
    alertSource: { id: 2269078, name: "Postil production" },
    timestamp: "2026-08-26T10:37:51.838605470Z",
    eventId: "7b21f505-bd0f-49a2-bf8f-f238919b23fc",
    escalationPolicy: { id: 2256025, name: "Default escalation" },
    mergeState: "NONE",
    ...overrides,
  };
}

function nextNotification(client: Client): Promise<Notification> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("notification timed out")), 2_000);
    client.once("notification", (notification) => {
      clearTimeout(timeout);
      resolve(notification);
    });
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 2_000;
  while (!output.includes(expected)) {
    if (Date.now() > deadline) throw new Error(`SSE output did not contain ${expected}`);
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(2_000).then(() => {
        throw new Error(`SSE read timed out waiting for ${expected}`);
      }),
    ]);
    if (next.done) break;
    output += decoder.decode(next.value, { stream: true });
  }
  return output;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
