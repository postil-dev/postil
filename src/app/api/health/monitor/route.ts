import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MONITOR_HEALTH_TIMEOUT_MS = 2_000;
const MONITOR_FRESHNESS_SECONDS = 15 * 60;
const MISSING_AGE_SECONDS = 2_147_483_647;

interface MonitorHealthRow {
  process_age_seconds: string;
  collection_age_seconds: string;
  heartbeat_delivery_age_seconds: string;
}

export async function GET(): Promise<NextResponse> {
  try {
    const result = await withTimeout(
      getPool().query<MonitorHealthRow>(`
        SELECT
          COALESCE(
            (SELECT EXTRACT(EPOCH FROM now() - observed_at)::int
               FROM service_heartbeats
              WHERE component = 'monitor'),
            ${MISSING_AGE_SECONDS}
          )::text AS process_age_seconds,
          COALESCE(
            (SELECT EXTRACT(EPOCH FROM now() - last_completed_at)::int
               FROM private_monitor_state
              WHERE id = 1),
            ${MISSING_AGE_SECONDS}
          )::text AS collection_age_seconds,
          COALESCE(
            (SELECT EXTRACT(EPOCH FROM now() - observed_at)::int
               FROM service_heartbeats
              WHERE component = 'monitor-heartbeat-delivery'),
            ${MISSING_AGE_SECONDS}
          )::text AS heartbeat_delivery_age_seconds
      `),
      MONITOR_HEALTH_TIMEOUT_MS,
    );
    const row = result.rows[0];
    if (!row) throw new Error("monitor health query returned no row");
    const process = componentState(row.process_age_seconds);
    const collection = componentState(row.collection_age_seconds);
    const heartbeatDelivery = componentState(
      row.heartbeat_delivery_age_seconds,
    );
    const ok = [process, collection, heartbeatDelivery].every(
      (state) => state === "up",
    );
    return NextResponse.json(
      { ok, monitor: { process, collection, heartbeatDelivery } },
      { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        monitor: {
          process: "unknown",
          collection: "unknown",
          heartbeatDelivery: "unknown",
        },
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

function componentState(value: string): "up" | "stale" | "missing" {
  const age = Number(value);
  if (!Number.isFinite(age) || age >= MISSING_AGE_SECONDS) return "missing";
  return age < MONITOR_FRESHNESS_SECONDS ? "up" : "stale";
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("monitor health check timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
