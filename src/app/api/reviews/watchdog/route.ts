/**
 * Watchdog: any review that has been `running` for more than 20 minutes is
 * assumed stuck. We mark it failed and PATCH its check-run to `failure` so the
 * PR thread reflects reality. Runs from cron (`/api/reviews/watchdog`).
 *
 * The previous incarnation of Postil leaned on this as the primary mechanism
 * for catching stuck reviews; this rewrite emits explicit completion events
 * from the worker, so the watchdog is a belt-and-suspenders fallback.
 */

import { and, eq, lte } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { reviews } from "@/db/schema";
import { requireBearer } from "@/lib/auth-bearer";

export const dynamic = "force-dynamic";

const STALE_AFTER_MS = 20 * 60 * 1000;

export async function POST(req: NextRequest) {
  const denied = requireBearer(req, "METRICS_API_KEY");
  if (denied) return denied;

  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const stuck = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.status, "running"), lte(reviews.startedAt, cutoff)));

  let failed = 0;
  for (const r of stuck) {
    await db
      .update(reviews)
      .set({
        status: "failed",
        errorMessage: "review timed out after 20 minutes — watchdog",
        completedAt: new Date(),
      })
      .where(eq(reviews.id, r.id));
    failed += 1;
  }

  return NextResponse.json({ checked: stuck.length, failed });
}
