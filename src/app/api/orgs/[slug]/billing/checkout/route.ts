import { NextResponse } from "next/server";

import { getOrgMembership } from "@/lib/org-access";
import {
  createPaddleCheckout,
  paddleCheckoutConfiguration,
} from "@/lib/paddle-billing";
import { publicOrigin } from "@/lib/oauth";
import { sameOriginMutation } from "@/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const expectedOrigin = publicOrigin(request);
  if (!sameOriginMutation(request, expectedOrigin)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const access = await getOrgMembership(slug);
  if (!access.ok) {
    if (access.reason === "verification_unavailable") {
      return NextResponse.json(
        { error: "membership verification unavailable" },
        { status: 503, headers: { "retry-after": "30" } },
      );
    }
    return NextResponse.json(
      {
        error:
          access.reason === "unauthenticated" ? "unauthorized" : "not found",
      },
      { status: access.reason === "unauthenticated" ? 401 : 404 },
    );
  }
  if (access.membership.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!paddleCheckoutConfiguration()) {
    return NextResponse.json(
      { error: "billing checkout is unavailable" },
      { status: 503, headers: { "retry-after": "300" } },
    );
  }
  try {
    const checkout = await createPaddleCheckout(access.db, {
      orgId: access.org.id,
      orgSlug: access.org.slug,
      requestedByUserId: access.user.id,
    });
    return NextResponse.json(checkout, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "billing checkout could not be started" },
      { status: 502, headers: { "retry-after": "30" } },
    );
  }
}
