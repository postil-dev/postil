import { NextResponse } from "next/server";

import { membershipRetryAfterHeader } from "@/lib/auth-navigation";
import { getOrgMembership } from "@/lib/org-access";
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
  const access = await getOrgMembership(slug);
  if (!access.ok) {
    if (access.reason === "verification_unavailable") {
      return NextResponse.json(
        { error: "membership verification unavailable" },
        {
          status: 503,
          headers: {
            "retry-after": membershipRetryAfterHeader(access.retryAvailableAt),
          },
        },
      );
    }
    return NextResponse.json(
      { error: access.reason === "unauthenticated" ? "unauthorized" : "not found" },
      { status: access.reason === "unauthenticated" ? 401 : 404 },
    );
  }
  const { db, org } = access;
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
