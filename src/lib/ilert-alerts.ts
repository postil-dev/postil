import { createHash, timingSafeEqual } from "node:crypto";

import { and, asc, eq, gt, sql } from "drizzle-orm";
import { Client, type Notification } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import { z } from "zod";

import {
  bearerCliToken,
  resolveCliToken,
  touchCliTokenLastUsed,
} from "@/lib/cli-auth";
import { type Database, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import { isOperatorUser } from "@/lib/operator-access";

export const ILERT_WEBHOOK_USERNAME = "postil-ilert";
export const ILERT_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const ILERT_ALERT_NOTIFY_CHANNEL = "postil_ilert_alert_events_v1";
export const ILERT_ALERT_REPLAY_LIMIT = 100;
export const ILERT_ALERT_REPLAY_MAX_BYTES = 256 * 1024;
export const ILERT_ALERT_STREAM_KEEPALIVE_MS = 15_000;

const ILERT_WEBHOOK_SECRET_MIN_BYTES = 32;
const ILERT_WEBHOOK_SECRET_MAX_BYTES = 512;
const ILERT_ALERT_STREAM_MAX_CONNECTIONS = 4;
const ILERT_ALERT_PENDING_NOTIFICATION_LIMIT = 256;
const POSTGRES_MAX_BIGINT = 9_223_372_036_854_775_807n;
const ILERT_EVENT_WRITE_LOCK = 580_178_254_943_325_001n;
const SUPABASE_POOLER_HOST = /(?:^|[.])pooler[.]supabase[.]com$/iu;

const ilertEventType = z
  .string()
  .max(64)
  .regex(/^alert-[a-z]+(?:-[a-z]+)*$/u);

const boundedTimestamp = z
  .string()
  .min(20)
  .max(40)
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u,
  )
  .refine((value) => Number.isFinite(Date.parse(value)));

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedUrl = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  });

const ilertResponderSchema = z.object({
  user: z.object({
    id: positiveSafeInteger,
    username: z.string().min(1).max(128),
    firstName: z.string().max(128),
    lastName: z.string().max(128),
    email: z.string().max(320),
  }),
  status: z.enum(["PENDING", "ACCEPTED"]),
});

const ilertWebhookSchema = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,63}$/u),
  summary: z.string().min(1).max(512),
  details: z.string().max(8_192),
  reportTime: boundedTimestamp,
  status: z.enum(["PENDING", "ACCEPTED", "RESOLVED"]),
  eventType: ilertEventType,
  priority: z.enum(["HIGH", "LOW"]),
  alertSource: z.object({
    id: positiveSafeInteger,
    name: z.string().min(1).max(256),
  }),
  responders: z.array(ilertResponderSchema).max(50).optional(),
  timestamp: boundedTimestamp,
  eventId: z.string().uuid(),
  correlationId: z.string().uuid().optional(),
  escalationPolicy: z.object({
    id: positiveSafeInteger,
    name: z.string().min(1).max(256),
  }),
  mergeState: z.enum(["NONE", "MAIN", "MERGED"]),
  alertKey: z.string().max(512).optional(),
  resolvedOn: boundedTimestamp.optional(),
  mergedOn: boundedTimestamp.optional(),
  mergedIntoId: z.string().regex(/^[1-9][0-9]{0,63}$/u).optional(),
  comment: z.string().max(4_096).optional(),
  links: z
    .array(
      z.object({
        href: boundedUrl,
        text: z.string().max(512).optional(),
      }),
    )
    .max(20)
    .optional(),
  images: z
    .array(
      z.object({
        src: boundedUrl,
        href: boundedUrl.optional(),
        alt: z.string().max(512).optional(),
      }),
    )
    .max(20)
    .optional(),
});

export type IlertAlertEventType = z.infer<typeof ilertEventType>;
export type ParsedIlertWebhookEvent = z.infer<typeof ilertWebhookSchema>;

export interface StoredIlertAlertEvent {
  sequence: bigint;
  eventId: string;
  alertId: string;
  eventType: IlertAlertEventType;
  status: "PENDING" | "ACCEPTED" | "RESOLVED";
  priority: "HIGH" | "LOW";
  summary: string;
  details: string;
  alertSourceId: bigint;
  alertSourceName: string;
  reportTime: Date;
  occurredAt: Date;
  payloadSha256: string;
  receivedAt: Date;
}

export type IlertAlertStreamAuthorization =
  | { status: "unauthorized" }
  | { status: "not_found" }
  | { status: "authorized"; expiresAt: Date };

export interface IlertAlertListener {
  close(): Promise<void>;
}

let activeIlertAlertListeners = 0;

/** Treat an absent or weak receiver secret as unconfigured. */
export function configuredIlertWebhookSecret(
  value = process.env.POSTIL_ILERT_WEBHOOK_SECRET,
): string | null {
  if (
    typeof value !== "string" ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    new Set(value).size < 4
  ) {
    return null;
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (
    byteLength < ILERT_WEBHOOK_SECRET_MIN_BYTES ||
    byteLength > ILERT_WEBHOOK_SECRET_MAX_BYTES
  ) {
    return null;
  }
  return value;
}

/** Verify iLert's URL-configured HTTP Basic credentials without logging them. */
export function verifyIlertWebhookAuthorization(
  authorizationHeader: string | null,
  secret: string,
): boolean {
  if (!authorizationHeader || authorizationHeader.length > 2_048) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(authorizationHeader);
  const encoded = match?.[1];
  if (!encoded || encoded.length % 4 !== 0) return false;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, "base64");
  } catch {
    return false;
  }
  if (decoded.toString("base64") !== encoded) return false;

  const separator = decoded.indexOf(0x3a);
  if (separator < 1) return false;
  const username = decoded.subarray(0, separator);
  const password = decoded.subarray(separator + 1);
  return (
    timingSafeTextEqual(username, Buffer.from(ILERT_WEBHOOK_USERNAME, "utf8")) &&
    timingSafeTextEqual(password, Buffer.from(secret, "utf8"))
  );
}

export function isApplicationJson(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function parseIlertWebhookBody(
  rawBody: Buffer,
): ParsedIlertWebhookEvent | null {
  let value: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    value = JSON.parse(source);
  } catch {
    return null;
  }
  const parsed = ilertWebhookSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Insert and notify atomically. Duplicate iLert event ids are silent. */
export async function recordIlertAlertEvent(
  db: Database,
  event: ParsedIlertWebhookEvent,
  rawBody: Buffer,
): Promise<{ duplicate: boolean; sequence: bigint | null }> {
  return db.transaction(async (tx) => {
    // Sequence allocation must match commit order so Last-Event-ID replay
    // cannot skip a slower transaction that allocated an earlier identity.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ILERT_EVENT_WRITE_LOCK.toString()}::bigint)`,
    );
    const inserted = await tx
      .insert(schema.ilertAlertEvents)
      .values({
        eventId: event.eventId,
        alertId: event.id,
        eventType: event.eventType,
        status: event.status,
        priority: event.priority,
        summary: event.summary,
        details: event.details,
        alertSourceId: BigInt(event.alertSource.id),
        alertSourceName: event.alertSource.name,
        reportTime: new Date(event.reportTime),
        occurredAt: new Date(event.timestamp),
        payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
      })
      .onConflictDoNothing({ target: schema.ilertAlertEvents.eventId })
      .returning({ sequence: schema.ilertAlertEvents.sequence });
    const sequence = inserted[0]?.sequence ?? null;
    if (sequence === null) return { duplicate: true, sequence: null };

    await tx.execute(
      sql`SELECT pg_notify(${ILERT_ALERT_NOTIFY_CHANNEL}, ${sequence.toString()})`,
    );
    return { duplicate: false, sequence };
  });
}

export async function replayIlertAlertEvents(
  db: Database,
  afterSequence: bigint,
): Promise<{ events: StoredIlertAlertEvent[]; overflow: boolean }> {
  const rows = await db
    .select()
    .from(schema.ilertAlertEvents)
    .where(gt(schema.ilertAlertEvents.sequence, afterSequence))
    .orderBy(asc(schema.ilertAlertEvents.sequence))
    .limit(ILERT_ALERT_REPLAY_LIMIT + 1);
  return {
    events: rows.slice(0, ILERT_ALERT_REPLAY_LIMIT) as StoredIlertAlertEvent[],
    overflow: rows.length > ILERT_ALERT_REPLAY_LIMIT,
  };
}

export async function getIlertAlertEvent(
  db: Database,
  sequence: bigint,
): Promise<StoredIlertAlertEvent | null> {
  const rows = await db
    .select()
    .from(schema.ilertAlertEvents)
    .where(eq(schema.ilertAlertEvents.sequence, sequence))
    .limit(1);
  return (rows[0] as StoredIlertAlertEvent | undefined) ?? null;
}

/** Require a renewable CLI login and the separate operator allowlist. */
export async function authorizeIlertAlertStream(
  db: Database,
  authorizationHeader: string | null,
): Promise<IlertAlertStreamAuthorization> {
  const token = bearerCliToken(authorizationHeader);
  const resolved = token ? await resolveCliToken(db, token) : null;
  if (!resolved || resolved.refreshSessionId === null) {
    return { status: "unauthorized" };
  }

  const rows = await db
    .select({
      githubId: schema.users.githubId,
      expiresAt: schema.cliTokens.expiresAt,
    })
    .from(schema.users)
    .innerJoin(
      schema.cliTokens,
      and(
        eq(schema.cliTokens.id, resolved.id),
        eq(schema.cliTokens.userId, schema.users.id),
      ),
    )
    .limit(1);
  const identity = rows[0];
  if (!identity || !isOperatorUser({ githubId: identity.githubId })) {
    return { status: "not_found" };
  }

  await touchCliTokenLastUsed(db, resolved.id).catch(() => undefined);
  return { status: "authorized", expiresAt: identity.expiresAt };
}

export function parseIlertLastEventId(value: string | null): bigint | null {
  if (value === null || value === "") return 0n;
  if (!/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) return null;
  const sequence = BigInt(value);
  return sequence <= POSTGRES_MAX_BIGINT ? sequence : null;
}

export function formatIlertAlertSseEvent(event: StoredIlertAlertEvent): string {
  const data = JSON.stringify({
    sequence: event.sequence.toString(),
    eventId: event.eventId,
    alertId: event.alertId,
    eventType: event.eventType,
    status: event.status,
    priority: event.priority,
    summary: event.summary,
    details: event.details,
    alertSource: {
      id: event.alertSourceId.toString(),
      name: event.alertSourceName,
    },
    reportTime: event.reportTime.toISOString(),
    occurredAt: event.occurredAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    payloadSha256: event.payloadSha256,
  });
  return `id: ${event.sequence.toString()}\nevent: ${event.eventType}\ndata: ${data}\n\n`;
}

/** Open one PostgreSQL push connection. This function never polls alert state. */
export async function openIlertAlertListener(
  onSequence: (sequence: bigint) => void,
  onUnavailable: () => void,
  connectionString = ilertAlertStreamDatabaseUrl(),
): Promise<IlertAlertListener> {
  if (activeIlertAlertListeners >= ILERT_ALERT_STREAM_MAX_CONNECTIONS) {
    throw new Error("alert stream connection limit reached");
  }
  try {
    parseConnectionString(connectionString);
  } catch {
    throw new Error("alert stream database configuration is invalid");
  }

  activeIlertAlertListeners += 1;
  const client = new Client({
    connectionString,
    application_name: "postil-ilert-alert-stream",
    connectionTimeoutMillis: 2_000,
    keepAlive: true,
  });
  let closed = false;

  const release = () => {
    if (closed) return false;
    closed = true;
    activeIlertAlertListeners -= 1;
    return true;
  };
  const fail = () => {
    if (!release()) return;
    client.removeAllListeners();
    void client.end().catch(() => undefined);
    onUnavailable();
  };
  const notification = (message: Notification) => {
    if (message.channel !== ILERT_ALERT_NOTIFY_CHANNEL || !message.payload) return;
    const sequence = parseIlertLastEventId(message.payload);
    if (sequence === null || sequence === 0n) {
      fail();
      return;
    }
    try {
      onSequence(sequence);
    } catch {
      fail();
    }
  };
  client.on("error", fail);
  client.on("end", fail);
  client.on("notification", notification);

  try {
    await client.connect();
    await client.query(`LISTEN ${ILERT_ALERT_NOTIFY_CHANNEL}`);
  } catch {
    release();
    client.removeAllListeners();
    await client.end().catch(() => undefined);
    throw new Error("alert stream database is unavailable");
  }

  return {
    async close() {
      if (!release()) return;
      client.removeAllListeners();
      await client
        .query(`UNLISTEN ${ILERT_ALERT_NOTIFY_CHANNEL}`)
        .catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}

/** Resolve a session-capable PostgreSQL URL without changing ordinary queries. */
export function ilertAlertStreamDatabaseUrl(
  databaseUrl = requireEnv("DATABASE_URL"),
): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("alert stream database configuration is invalid");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("alert stream database configuration is invalid");
  }
  if (parsed.port === "6543") {
    if (!SUPABASE_POOLER_HOST.test(parsed.hostname)) {
      throw new Error("alert stream requires a session-capable database endpoint");
    }
    parsed.port = "5432";
    parsed.searchParams.delete("pgbouncer");
  }
  return parsed.toString();
}

export function ilertAlertPendingNotificationLimit(): number {
  return ILERT_ALERT_PENDING_NOTIFICATION_LIMIT;
}

function timingSafeTextEqual(left: Buffer, right: Buffer): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
