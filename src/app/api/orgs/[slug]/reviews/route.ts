import { NextResponse } from "next/server";

import { requireOrgMembership } from "@/lib/org-access";
import { getOrgReviewRows } from "@/lib/org-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const { db, org } = await requireOrgMembership(slug);
  const requestedLimit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "",
    10,
  );
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const reviews = await getOrgReviewRows(db, org.id, limit);

  return NextResponse.json(reviews, {
    headers: { "cache-control": "private, no-store" },
  });
}
