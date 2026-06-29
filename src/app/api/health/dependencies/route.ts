import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATABASE_HEALTH_TIMEOUT_MS = 2_000;

export async function GET(): Promise<NextResponse> {
  try {
    await withTimeout(getPool().query("SELECT 1"), DATABASE_HEALTH_TIMEOUT_MS);
    return NextResponse.json({ ok: true, database: "up" });
  } catch {
    return NextResponse.json(
      { ok: false, database: "down", error: "database health check failed" },
      { status: 503 },
    );
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("database health check timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
