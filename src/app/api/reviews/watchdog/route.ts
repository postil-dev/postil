import { NextResponse } from "next/server";
import { completeStaleReviewCheckRuns } from "@/jobs/review-watchdog";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  if (!env.METRICS_API_KEY) {
    return NextResponse.json({ error: "watchdog auth is not configured" }, { status: 503 });
  }

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.METRICS_API_KEY}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await completeStaleReviewCheckRuns();
  return NextResponse.json({ ok: true, ...result });
}
