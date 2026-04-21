import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { captureException, track } from "@/lib/posthog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYNCHRONIZE_DEBOUNCE_MS = 30_000;

function verifySignature(payload: string, signature: string | null): boolean {
  if (!signature || !env.GITHUB_WEBHOOK_SECRET) return false;
  const hmac = crypto.createHmac("sha256", env.GITHUB_WEBHOOK_SECRET);
  hmac.update(payload);
  const expected = `sha256=${hmac.digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  const deliveryId = req.headers.get("x-github-delivery");
  const event = req.headers.get("x-github-event");
  const signature = req.headers.get("x-hub-signature-256");
  const body = await req.text();

  if (!deliveryId || !event) {
    return NextResponse.json({ error: "missing headers" }, { status: 400 });
  }
  if (!verifySignature(body, signature)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const payload = JSON.parse(body);

  // Dedupe on delivery id.
  const db = getDb();
  try {
    await db
      .insert(schema.webhookDeliveries)
      .values({ source: "github", deliveryId, event, payload });
  } catch (err) {
    // Unique violation = duplicate delivery; ack idempotently.
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: true, deduped: true });
    }
    captureException(err, { properties: { event, deliveryId } });
    return NextResponse.json({ error: "storage failure" }, { status: 500 });
  }

  try {
    switch (event) {
      case "pull_request":
        await handlePullRequest(payload);
        break;
      case "pull_request_review":
      case "issue_comment":
      case "installation":
      case "installation_repositories":
        // TODO(postil): route these to specific handlers.
        break;
      default:
        break;
    }
  } catch (err) {
    captureException(err, { properties: { event, deliveryId } });
    return NextResponse.json({ error: "handler failure" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

type PullRequestPayload = {
  action: string;
  pull_request: {
    number: number;
    head: { sha: string };
    draft: boolean;
  };
  repository: { full_name: string };
  installation?: { id: number };
};

async function handlePullRequest(p: PullRequestPayload): Promise<void> {
  const { action, pull_request, repository, installation } = p;
  if (!installation) return;
  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(action)) return;
  if (pull_request.draft) return;

  const db = getDb();
  const repoFullName = repository.full_name;
  const pullNumber = pull_request.number;
  const headSha = pull_request.head.sha;

  // Debounce synchronize: if there is an in-flight review for this PR within
  // the debounce window, skip enqueuing a new one.
  if (action === "synchronize") {
    const existing = await db.query.reviews.findFirst({
      where: and(
        eq(schema.reviews.repoFullName, repoFullName),
        eq(schema.reviews.pullNumber, pullNumber),
      ),
      orderBy: (r, { desc }) => [desc(r.createdAt)],
    });
    if (existing && Date.now() - existing.createdAt.getTime() < SYNCHRONIZE_DEBOUNCE_MS) {
      return;
    }
  }

  // TODO(postil): resolve organizationId from installation.id via installations table.
  // TODO(postil): enqueue trigger.dev task `reviewPullRequest`.
  track("system", "review_enqueued", {
    repoFullName,
    pullNumber,
    headSha,
    installationId: installation.id,
  });
}
