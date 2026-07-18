import { NextResponse } from "next/server";

import { readBoundedWebhookBody } from "@/lib/crypto/webhook";
import { getDb } from "@/lib/db";
import {
  applyPaddleWebhookEvent,
  unmarshalPaddleWebhook,
} from "@/lib/paddle-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PADDLE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const signature = request.headers.get("paddle-signature");
  if (!signature) {
    return NextResponse.json({ error: "signature required" }, { status: 400 });
  }
  const body = await readBoundedWebhookBody(
    request,
    PADDLE_WEBHOOK_MAX_BODY_BYTES,
  );
  if (!body.ok) {
    return NextResponse.json(
      { error: body.status === 413 ? "payload too large" : "invalid body" },
      { status: body.status },
    );
  }
  const rawBody = body.body.toString("utf8");
  let event;
  try {
    event = await unmarshalPaddleWebhook(rawBody, signature);
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }
  try {
    const result = await applyPaddleWebhookEvent(getDb(), event);
    return NextResponse.json({ accepted: true, duplicate: result.duplicate });
  } catch {
    return NextResponse.json(
      { error: "webhook processing unavailable" },
      { status: 503, headers: { "retry-after": "30" } },
    );
  }
}
