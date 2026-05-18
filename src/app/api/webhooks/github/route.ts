import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { reviewPullRequest } from "@/jobs/review-pull-request";
import { env } from "@/lib/env";
import { installationOctokit } from "@/lib/github";
import { captureException, track } from "@/lib/posthog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  const db = getDb();
  try {
    await db
      .insert(schema.webhookDeliveries)
      .values({ source: "github", deliveryId, event, payload });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: true, deduped: true });
    }
    captureException(err, { properties: { event, deliveryId } });
    return NextResponse.json({ error: "storage failure" }, { status: 500 });
  }

  if (event === "pull_request") {
    await handlePullRequest(payload);
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

  // Create an in-progress check-run so the PR shows "postil/review" immediately.
  let checkRunId: number | undefined;
  try {
    const octokit = await installationOctokit(installation.id);
    const [owner, repo] = repoFullName.split("/");
    const checkRun = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: "postil/review",
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: "Postil is reviewing...",
        summary: "The review is in progress.",
      },
    });
    checkRunId = checkRun.data.id;
  } catch (err) {
    captureException(err, {
      properties: { op: "create_check_run", repoFullName, pullNumber, headSha },
    });
    // Continue without check-run; inline comments still work.
  }

  const reviewRow = await db
    .insert(schema.reviews)
    .values({
      installationId: installation.id,
      repoFullName,
      pullNumber,
      headSha,
      status: "running",
      checkRunId: checkRunId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.reviews.id });

  const reviewId = reviewRow[0]?.id;

  const handle = await reviewPullRequest.trigger({
    installationId: installation.id,
    repoFullName,
    pullNumber,
    headSha,
    checkRunId: checkRunId ?? undefined,
    reviewId: reviewId ?? undefined,
  });

  if (reviewId) {
    await db
      .update(schema.reviews)
      .set({ triggerRunId: handle.id })
      .where(eq(schema.reviews.id, reviewId));
  }

  track("system", "review_enqueued", {
    repoFullName,
    pullNumber,
    headSha,
    installationId: installation.id,
    reviewId,
    checkRunId,
    triggerRunId: handle.id,
  });
}
