import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({ ok: true, database: "up" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, database: "down", error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
