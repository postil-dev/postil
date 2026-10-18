import { NextResponse } from "next/server";

import { readBoundedWebhookBody } from "@/lib/crypto/webhook";
import { getDb } from "@/lib/db";
import {
  configuredIlertWebhookSecret,
  ILERT_WEBHOOK_MAX_BODY_BYTES,
  isApplicationJson,
  parseIlertWebhookBody,
  recordIlertAlertEvent,
  verifyIlertWebhookAuthorization,
} from "@/lib/ilert-alerts";
import { reportOperationalFailure } from "@/lib/server-observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = configuredIlertWebhookSecret();
  if (!secret) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (
    !verifyIlertWebhookAuthorization(
      request.headers.get("authorization"),
      secret,
    )
  ) {
    return NextResponse.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: {
          "www-authenticate": 'Basic realm="postil-ilert", charset="UTF-8"',
        },
      },
    );
  }
  if (!isApplicationJson(request.headers.get("content-type"))) {
    return NextResponse.json(
      { error: "application/json required" },
      { status: 415 },
    );
  }

  const body = await readBoundedWebhookBody(
    request,
    ILERT_WEBHOOK_MAX_BODY_BYTES,
  );
  if (!body.ok) {
    return NextResponse.json(
      { error: body.status === 413 ? "payload too large" : "invalid body" },
      { status: body.status },
    );
  }
  const event = parseIlertWebhookBody(body.body);
  if (!event) {
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  }

  try {
    const result = await recordIlertAlertEvent(getDb(), event, body.body);
    return NextResponse.json(
      {
        accepted: true,
        duplicate: result.duplicate,
        sequence: result.sequence?.toString() ?? null,
      },
      { status: 202 },
    );
  } catch (error) {
    reportOperationalFailure("web", "ilert_webhook_processing_failed", error);
    return NextResponse.json(
      { error: "webhook processing unavailable" },
      { status: 503, headers: { "retry-after": "30" } },
    );
  }
}
