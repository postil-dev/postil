import { NextResponse } from "next/server";

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import { schema } from "@/lib/db";
import { getOrgMembership } from "@/lib/org-access";
import { reviewDisplayStatus } from "@/lib/review-outcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LINES_PER_RESPONSE = 500;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; publicId: string }> },
): Promise<NextResponse> {
  const { slug, publicId } = await params;
  const access = await getOrgMembership(slug);
  if (!access.ok) {
    if (access.reason === "verification_unavailable") {
      return NextResponse.json(
        { error: "membership verification unavailable" },
        { status: 503, headers: { "retry-after": "30" } },
      );
    }
    return NextResponse.json(
      { error: access.reason === "unauthenticated" ? "unauthorized" : "not found" },
      { status: access.reason === "unauthenticated" ? 401 : 404 },
    );
  }
  if (!UUID_PATTERN.test(publicId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const afterParam = new URL(request.url).searchParams.get("after");
  const after = afterParam === null ? 0 : Number(afterParam);
  if (!Number.isSafeInteger(after) || after < 0) {
    return NextResponse.json({ error: "after must be a non-negative integer" }, { status: 400 });
  }

  const review = (
    await access.db
      .select({
        id: schema.reviews.id,
        status: schema.reviews.status,
        errorMessage: schema.reviews.errorMessage,
        envelope: schema.reviews.envelope,
        finishedAt: schema.reviews.finishedAt,
        gateFailing: schema.reviews.gateFailing,
      })
      .from(schema.reviews)
      .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(
        and(
          eq(schema.reviews.publicId, publicId),
          eq(schema.installations.orgId, access.org.id),
        ),
      )
      .limit(1)
  )[0];
  if (!review) return NextResponse.json({ error: "not found" }, { status: 404 });

  const lines = await access.db
    .select({
      seq: schema.reviewLogs.seq,
      at: schema.reviewLogs.at,
      line: schema.reviewLogs.line,
    })
    .from(schema.reviewLogs)
    .where(and(eq(schema.reviewLogs.reviewId, review.id), gt(schema.reviewLogs.seq, after)))
    .orderBy(asc(schema.reviewLogs.seq))
    .limit(MAX_LINES_PER_RESPONSE);
  const gateSync = (await access.db
    .select({ status: schema.jobs.status })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.kind, "gate-state-sync"),
      sql`${schema.jobs.payload}->>'reviewId' = ${String(review.id)}`,
    ))
    .orderBy(desc(schema.jobs.id))
    .limit(1))[0];

  return NextResponse.json({
    lines,
    status: reviewDisplayStatus(review.status, review.errorMessage, review.envelope),
    finishedAt: review.finishedAt,
    gateFailing: review.gateFailing,
    gateSyncStatus: gateSync?.status ?? null,
  });
}
