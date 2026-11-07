import { NextResponse } from "next/server";

import { readBoundedWebhookBody } from "@/lib/crypto/webhook";
import { getDb } from "@/lib/db";
import {
  configuredIlertWebhookSecret,
  hasIlertCanaryAlertEvent,
  ILERT_WEBHOOK_MAX_BODY_BYTES,
  isApplicationJson,
  isIlertCanaryAlertKey,
  parseIlertWebhookBody,
  recordIlertAlertEvent,
  verifyIlertWebhookAuthorization,
} from "@/lib/ilert-alerts";
import { reportOperationalFailure } from "@/lib/server-observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const canarySourceId = /^[1-9][0-9]{0,18}$/u;
const POSTGRES_MAX_BIGINT = 9_223_372_036_854_775_807n;

export async function GET(request: Request): Promise<NextResponse> {
  const unauthorized = authorizeIlertWebhook(request);
  if (unauthorized) return unauthorized;

  const query = new URL(request.url).searchParams;
  if (query.size === 0) {
    return new NextResponse(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }
  const alertKey = query.get("alertKey");
  const eventType = query.get("eventType");
  const sourceId = query.get("sourceId");
  if (
    query.size !== 3 ||
    !alertKey ||
    !isIlertCanaryAlertKey(alertKey) ||
    (eventType !== "alert-created" && eventType !== "alert-resolved") ||
    !sourceId ||
    !canarySourceId.test(sourceId) ||
    BigInt(sourceId) > POSTGRES_MAX_BIGINT
  ) {
    return NextResponse.json(
      { error: "invalid canary observation" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const received = await hasIlertCanaryAlertEvent(
      getDb(),
      alertKey,
      eventType,
      BigInt(sourceId),
    );
    return NextResponse.json(
      { received },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    reportOperationalFailure("web", "ilert_webhook_processing_failed", error);
    return NextResponse.json(
      { error: "webhook observation unavailable" },
      {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "5" },
      },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const unauthorized = authorizeIlertWebhook(request);
  if (unauthorized) return unauthorized;
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

function authorizeIlertWebhook(request: Request): NextResponse | null {
  const secret = configuredIlertWebhookSecret();
  if (!secret) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (
    verifyIlertWebhookAuthorization(
      request.headers.get("authorization"),
      secret,
    )
  ) {
    return null;
  }
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
