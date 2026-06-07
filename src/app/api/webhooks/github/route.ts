import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { attemptAutoMergeApprovedPull, hasApprovedReview } from "@/jobs/auto-merge";
import { enqueueReviewPullRequest } from "@/jobs/review-pull-request";
import { loadReviewConfig } from "@/lib/config";
import { env } from "@/lib/env";
import { authenticatedAppSlug, installationOctokit, mintInstallationToken } from "@/lib/github";
import { captureException, track } from "@/lib/posthog";
import { encryptReviewInstallationToken } from "@/lib/review-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireTriggerSecretKey(): string {
  const secret = env.reviewTokenSecret?.trim();
  if (!secret) {
    throw new Error("REVIEW_TOKEN_SECRET or TRIGGER_SECRET_KEY must be set to encrypt review installation tokens");
  }
  return secret;
}
export const maxDuration = 300;

const SYNCHRONIZE_DEBOUNCE_MS = 30_000;
const REVIEW_WORKFLOW_PATH = ".github/workflows/postil-review.yml";
const REVIEW_WORKFLOW_FAILURE_CONCLUSIONS = new Set(["cancelled", "failure"]);
const REVIEW_WORKFLOW_NON_BLOCKING_CONCLUSIONS = new Set(["neutral", "success"]);

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
    await handlePullRequest(db, payload, deliveryId);
  }
  if (
    event === "issue_comment" ||
    event === "pull_request_review" ||
    event === "pull_request_review_comment"
  ) {
    await handleMention(db, event, payload, deliveryId);
  }
  if (event === "workflow_run") {
    await handleWorkflowRun(payload);
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

type MentionPayload = {
  action: string;
  repository: { full_name: string };
  installation?: { id: number };
  issue?: { number?: number; pull_request?: unknown };
  pull_request?: { number?: number };
  comment?: { body?: string | null };
  review?: { body?: string | null };
};

type WorkflowRunPayload = {
  action: string;
  workflow?: {
    id?: number | null;
    name?: string | null;
    path?: string | null;
  } | null;
  workflow_run: {
    id: number;
    name?: string | null;
    conclusion?: string | null;
    html_url: string;
    head_branch?: string | null;
    head_sha?: string | null;
    path?: string | null;
    actor?: { login?: string | null } | null;
    pull_requests?: Array<{ number: number; head?: { sha?: string | null } | null }>;
  };
  repository: { full_name: string };
  installation?: { id: number };
};

type MinimalOctokit = {
  request: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>;
};

type WorkflowJob = {
  id: number;
  name: string;
  conclusion?: string | null;
  html_url?: string | null;
  steps?: Array<{
    name: string;
    conclusion?: string | null;
    status?: string | null;
  }>;
};

type ReviewCheckRun = { id: string; checkRunId: number } | null | undefined;
type ReviewWorkflowRunContext = { pullNumber: number | null; headSha: string | null };

async function handlePullRequest(
  db: ReturnType<typeof getDb>,
  p: PullRequestPayload,
  deliveryId: string,
): Promise<void> {
  const { action, pull_request, repository, installation } = p;
  if (!installation) return;
  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(action)) return;
  if (pull_request.draft) return;
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
    if (
      existing &&
      existing.status !== "failed" &&
      Date.now() - existing.createdAt.getTime() < SYNCHRONIZE_DEBOUNCE_MS
    ) {
      return;
    }
  }

  await dispatchReview(db, {
    deliveryId,
    installationId: installation.id,
    repoFullName,
    pullNumber,
    headSha,
  });
}

async function handleMention(
  db: ReturnType<typeof getDb>,
  event: string,
  p: MentionPayload,
  deliveryId: string,
): Promise<void> {
  if (!p.installation) return;
  if (!["created", "submitted"].includes(p.action)) return;
  const body = p.comment?.body ?? p.review?.body ?? "";
  if (!mentionsPostil(body)) return;

  const pullNumber =
    event === "issue_comment" ? p.issue?.number : (p.pull_request?.number ?? p.issue?.number);
  if (!pullNumber) return;
  if (event === "issue_comment" && !p.issue?.pull_request) return;

  const repoFullName = p.repository.full_name;
  const [owner, repo] = repoFullName.split("/");
  const octokit = await installationOctokit(p.installation.id);
  const pull = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
  });
  const data = pull.data as { draft?: unknown; head?: { sha?: unknown } };
  if (data.draft === true) return;
  const headSha = String(data.head?.sha ?? "");
  if (!headSha) return;

  await dispatchReview(db, {
    deliveryId,
    installationId: p.installation.id,
    repoFullName,
    pullNumber,
    headSha,
    forceCheckRun: true,
  });

  track("system", "review_mentioned", {
    repoFullName,
    pullNumber,
    headSha,
    event,
  });
}

function mentionsPostil(body: string | null | undefined): boolean {
  return /(^|[^\w-])@postil(?:-dev)?\b/i.test(body ?? "");
}

async function markCheckRunQueued(input: {
  installationId: number;
  repoFullName: string;
  checkRunId: number;
  triggerRunId: string;
}): Promise<void> {
  const octokit = await installationOctokit(input.installationId);
  const [owner, repo] = input.repoFullName.split("/");
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: input.checkRunId,
    status: "in_progress",
    output: {
      title: "Postil review queued",
      summary: "Postil queued the hosted review worker.",
      text: `Trigger run: ${input.triggerRunId}`,
    },
  });
}

async function dispatchReview(
  db: ReturnType<typeof getDb>,
  input: {
    deliveryId: string;
    installationId: number;
    repoFullName: string;
    pullNumber: number;
    headSha: string;
    forceCheckRun?: boolean;
  },
): Promise<void> {
  const { deliveryId, installationId, repoFullName, pullNumber, headSha, forceCheckRun } = input;
  const reviewRow = await db
    .insert(schema.reviews)
    .values({
      installationId,
      repoFullName,
      pullNumber,
      headSha,
      status: "running",
      checkRunId: null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.reviews.id });

  let reviewId: string | undefined = reviewRow[0]?.id;
  let checkRunId: number | undefined;

  if (!reviewId) {
    const existing = await db.query.reviews.findFirst({
      where: and(
        eq(schema.reviews.repoFullName, repoFullName),
        eq(schema.reviews.pullNumber, pullNumber),
        eq(schema.reviews.headSha, headSha),
      ),
      orderBy: (r, { desc }) => [desc(r.createdAt)],
      columns: { id: true, checkRunId: true },
    });
    reviewId = existing?.id;
    checkRunId = forceCheckRun ? undefined : (existing?.checkRunId ?? undefined);
    if (reviewId) {
      await db
        .update(schema.reviews)
        .set({
          status: "running",
          errorMessage: null,
          completedAt: null,
        })
        .where(eq(schema.reviews.id, reviewId));
    }
  }

  if (!reviewId) {
    throw new Error("failed to initialize review row");
  }

  if (!checkRunId) {
    // Create an in-progress check-run so the PR shows "postil/review" immediately.
    try {
      const octokit = await installationOctokit(installationId);
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
      await db
        .update(schema.reviews)
        .set({
          checkRunId,
        })
        .where(eq(schema.reviews.id, reviewId));
    } catch (err) {
      captureException(err, {
        properties: { op: "create_check_run", repoFullName, pullNumber, headSha },
      });
      await recordReviewDispatchFailure(db, reviewId, err, repoFullName, pullNumber, headSha);
      await deleteWebhookDelivery(db, deliveryId);
      throw err;
    }
  }

  try {
    const triggerSecretKey = requireTriggerSecretKey();
    const installationToken = await mintInstallationToken(installationId);
    const encryptedInstallationToken = encryptReviewInstallationToken({
      token: installationToken,
      secret: triggerSecretKey,
      context: {
        installationId,
        repoFullName,
        pullNumber,
        headSha,
      },
    });
    const triggerRun = await enqueueReviewPullRequest(
      {
        installationId,
        repoFullName,
        pullNumber,
        headSha,
        checkRunId,
        reviewId,
        encryptedInstallationToken,
      },
      deliveryId,
    );

    try {
      await db
        .update(schema.reviews)
        .set({
          triggerRunId: triggerRun.id,
        })
        .where(eq(schema.reviews.id, reviewId));
    } catch (updateErr) {
      captureException(updateErr, {
        properties: {
          op: "record_trigger_run_id",
          repoFullName,
          pullNumber,
          headSha,
          reviewId,
          triggerRunId: triggerRun.id,
        },
      });
    }

    try {
      track("system", "review_enqueued", {
        repoFullName,
        pullNumber,
        headSha,
        installationId,
        reviewId,
        checkRunId,
        triggerRunId: triggerRun.id,
      });
    } catch (trackErr) {
      captureException(trackErr, {
        properties: {
          op: "track_review_enqueued",
          repoFullName,
          pullNumber,
          headSha,
          reviewId,
          triggerRunId: triggerRun.id,
        },
      });
    }

    if (checkRunId) {
      try {
        await markCheckRunQueued({
          installationId,
          repoFullName,
          checkRunId,
          triggerRunId: triggerRun.id,
        });
      } catch (checkRunErr) {
        captureException(checkRunErr, {
          properties: {
            op: "mark_check_run_queued",
            repoFullName,
            pullNumber,
            headSha,
            reviewId,
            triggerRunId: triggerRun.id,
          },
        });
      }
    }

    return;
  } catch (err) {
    await recordReviewDispatchFailure(db, reviewId, err, repoFullName, pullNumber, headSha);
    captureException(err, {
      properties: {
        op: "trigger_review_pull_request",
        repoFullName,
        pullNumber,
        headSha,
      },
    });
    if (checkRunId) {
      try {
        const octokit = await installationOctokit(installationId);
        const [owner, repo] = repoFullName.split("/");
        await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
          owner,
          repo,
          check_run_id: checkRunId,
          status: "completed",
          conclusion: "failure",
          completed_at: new Date().toISOString(),
          output: {
            title: "Postil review dispatch failed",
            summary: "The review could not be enqueued.",
          },
        });
      } catch (checkRunErr) {
        captureException(checkRunErr, {
          properties: {
            op: "fail_check_run_after_enqueue_error",
            repoFullName,
            pullNumber,
            headSha,
          },
        });
      }
    }
    await deleteWebhookDelivery(db, deliveryId);
    throw err;
  }
}

async function recordReviewDispatchFailure(
  db: ReturnType<typeof getDb>,
  reviewId: string,
  err: unknown,
  repoFullName: string,
  pullNumber: number,
  headSha: string,
): Promise<void> {
  try {
    await db
      .update(schema.reviews)
      .set({
        status: "failed",
        errorMessage: String(err instanceof Error ? err.message : err),
        completedAt: new Date(),
      })
      .where(eq(schema.reviews.id, reviewId));
  } catch (updateErr) {
    captureException(updateErr, {
      properties: {
        op: "record_dispatch_failed",
        repoFullName,
        pullNumber,
        headSha,
        reviewId,
      },
    });
  }
}

async function completeReviewWorkflowFailureCheckRun(
  db: ReturnType<typeof getDb>,
  octokit: MinimalOctokit,
  repoFullName: string,
  pullNumber: number | null,
  candidateHeadShas: Array<string | null | undefined>,
  conclusion: string | null | undefined,
): Promise<void> {
  let review: ReviewCheckRun;
  try {
    review = await findReviewCheckRunForWorkflowCompletion(
      db,
      octokit,
      repoFullName,
      pullNumber,
      candidateHeadShas,
    );
  } catch (err) {
    captureException(err, {
      properties: {
        op: "lookup_review_for_workflow_failure",
        repoFullName,
        pullNumber,
      },
    });
    return;
  }

  if (!review?.checkRunId) {
    captureException(new Error("Review workflow failure did not match a review check-run"), {
      properties: {
        op: "review_workflow_failure_check_run_unmatched",
        repoFullName,
        pullNumber,
      },
    });
    return;
  }

  const completedAt = new Date();
  try {
    if (review.id) {
      await db
        .update(schema.reviews)
        .set({
          status: "failed",
          checkRunId: review.checkRunId,
          errorMessage: `Review workflow ${conclusion === "cancelled" ? "cancelled" : "failed"} before review completion.`,
          completedAt,
        })
        .where(eq(schema.reviews.id, review.id));
    }
  } catch (err) {
    captureException(err, {
      properties: {
        op: "record_review_workflow_failure",
        repoFullName,
        pullNumber,
        reviewId: review.id,
      },
    });
  }

  const [owner, repo] = repoFullName.split("/");
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner,
      repo,
      check_run_id: review.checkRunId,
      status: "completed",
      conclusion: "failure",
      completed_at: completedAt.toISOString(),
      output: {
        title: "Postil Review",
        summary: "Review failed to complete.",
        text: "Review failed to complete.",
      },
    });
  } catch (err) {
    captureException(err, {
      properties: {
        op: "complete_review_workflow_failure_check_run",
        repoFullName,
        pullNumber,
        reviewId: review.id,
        checkRunId: review.checkRunId,
      },
    });
  }
}

async function completeReviewWorkflowSuccessCheckRun(
  db: ReturnType<typeof getDb>,
  octokit: MinimalOctokit,
  repoFullName: string,
  pullNumber: number | null,
  candidateHeadShas: Array<string | null | undefined>,
  conclusion: "neutral" | "success",
): Promise<void> {
  let review: ReviewCheckRun;
  try {
    review = await findReviewCheckRunForWorkflowCompletion(
      db,
      octokit,
      repoFullName,
      pullNumber,
      candidateHeadShas,
    );
  } catch (err) {
    captureException(err, {
      properties: {
        op: "lookup_review_for_workflow_success",
        repoFullName,
        pullNumber,
      },
    });
    return;
  }

  if (!review?.checkRunId) return;

  const completedAt = new Date();
  try {
    if (review.id) {
      await db
        .update(schema.reviews)
        .set({
          status: "completed",
          checkRunId: review.checkRunId,
          completedAt,
        })
        .where(eq(schema.reviews.id, review.id));
    }
  } catch (err) {
    captureException(err, {
      properties: {
        op: "record_review_workflow_success",
        repoFullName,
        pullNumber,
        reviewId: review.id,
      },
    });
  }

  const [owner, repo] = repoFullName.split("/");
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner,
      repo,
      check_run_id: review.checkRunId,
      status: "completed",
      conclusion,
      completed_at: completedAt.toISOString(),
      output: {
        title: "Postil Review",
        summary: "Review completed.",
        text: "Review completed.",
      },
    });
  } catch (err) {
    captureException(err, {
      properties: {
        op: "complete_review_workflow_success_check_run",
        repoFullName,
        pullNumber,
        reviewId: review.id,
        checkRunId: review.checkRunId,
      },
    });
  }
}

async function findReviewCheckRunForWorkflowCompletion(
  db: ReturnType<typeof getDb>,
  octokit: MinimalOctokit,
  repoFullName: string,
  pullNumber: number | null,
  candidateHeadShas: Array<string | null | undefined>,
): Promise<ReviewCheckRun> {
  const uniqueHeadShas = [
    ...new Set(candidateHeadShas.filter((sha): sha is string => Boolean(sha))),
  ];
  const [owner, repo] = repoFullName.split("/");
  let appSlug: string | null | undefined;

  for (const headSha of uniqueHeadShas) {
    const where = [
      eq(schema.reviews.repoFullName, repoFullName),
      eq(schema.reviews.headSha, headSha),
    ];
    if (pullNumber !== null) {
      where.push(eq(schema.reviews.pullNumber, pullNumber));
    }

    const review = await db.query.reviews.findFirst({
      where: and(...where),
      orderBy: (reviews, { desc: orderDesc }) => [orderDesc(reviews.createdAt)],
      columns: { id: true, checkRunId: true },
    });
    if (!review?.id) continue;
    try {
      if (appSlug === undefined) {
        appSlug = await authenticatedAppSlug();
      }
      if (!appSlug)
        return review?.checkRunId ? { id: review.id, checkRunId: review.checkRunId } : null;
      const expectedAppSlug = appSlug;

      const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        owner,
        repo,
        ref: headSha,
        check_name: "postil/review",
        per_page: 100,
      });
      const checkRuns = (res.data as { check_runs?: Array<Record<string, unknown>> }).check_runs;
      const appOwnedReviewCheck = (Array.isArray(checkRuns) ? checkRuns : []).find((checkRun) => {
        if (checkRun.name !== "postil/review") return false;
        if (!isCheckRunOwnedByApp(checkRun, expectedAppSlug)) return false;
        return typeof checkRun.id === "number";
      });
      if (typeof appOwnedReviewCheck?.id === "number") {
        return { id: review.id, checkRunId: appOwnedReviewCheck.id };
      }
    } catch (err) {
      if (!review?.checkRunId) throw err;
    }
    if (review?.checkRunId) return { id: review.id, checkRunId: review.checkRunId };
  }

  return null;
}

function isCheckRunOwnedByApp(checkRun: Record<string, unknown>, appSlug: string): boolean {
  const app = checkRun.app as { slug?: unknown } | null | undefined;
  return app?.slug === appSlug;
}

function resolveReviewWorkflowRunContext(
  workflowRun: WorkflowRunPayload["workflow_run"],
): ReviewWorkflowRunContext {
  const payloadPull = workflowRun.pull_requests?.[0];
  return { pullNumber: payloadPull?.number ?? null, headSha: payloadPull?.head?.sha ?? null };
}

function isReviewWorkflowFailureConclusion(conclusion: string | null | undefined): boolean {
  return (
    conclusion !== null &&
    conclusion !== undefined &&
    REVIEW_WORKFLOW_FAILURE_CONCLUSIONS.has(conclusion)
  );
}

function isReviewWorkflowNonBlockingConclusion(
  conclusion: string | null | undefined,
): conclusion is "neutral" | "success" {
  return (
    conclusion !== null &&
    conclusion !== undefined &&
    REVIEW_WORKFLOW_NON_BLOCKING_CONCLUSIONS.has(conclusion)
  );
}

async function deleteWebhookDelivery(
  db: ReturnType<typeof getDb>,
  deliveryId: string,
): Promise<void> {
  try {
    await db
      .delete(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.source, "github"),
          eq(schema.webhookDeliveries.deliveryId, deliveryId),
        ),
      );
  } catch (deleteErr) {
    captureException(deleteErr, {
      properties: { op: "delete_webhook_delivery_after_enqueue_error", deliveryId },
    });
  }
}

async function handleWorkflowRun(p: WorkflowRunPayload): Promise<void> {
  const { action, workflow, workflow_run, repository, installation } = p;
  if (!installation) return;
  if (action !== "completed") return;

  const pullNumber = workflow_run.pull_requests?.[0]?.number;
  const repoFullName = repository.full_name;
  const [owner, repo] = repoFullName.split("/");
  const octokit = (await installationOctokit(installation.id)) as MinimalOctokit;

  if (workflow?.path === REVIEW_WORKFLOW_PATH || workflow_run.path === REVIEW_WORKFLOW_PATH) {
    const reviewContext = resolveReviewWorkflowRunContext(workflow_run);
    const candidateHeadShas = [workflow_run.head_sha ?? null, reviewContext.headSha];
    if (isReviewWorkflowNonBlockingConclusion(workflow_run.conclusion)) {
      await completeReviewWorkflowSuccessCheckRun(
        getDb(),
        octokit,
        repoFullName,
        pullNumber ?? reviewContext.pullNumber,
        candidateHeadShas,
        workflow_run.conclusion,
      );
    } else if (isReviewWorkflowFailureConclusion(workflow_run.conclusion)) {
      await completeReviewWorkflowFailureCheckRun(
        getDb(),
        octokit,
        repoFullName,
        pullNumber ?? reviewContext.pullNumber,
        candidateHeadShas,
        workflow_run.conclusion,
      );
    }
    return;
  }

  if (!pullNumber) return;

  if (workflow_run.conclusion === "success") {
    if (workflow_run.name !== "CI" || !workflow_run.head_sha) return;

    try {
      if (
        !(await hasApprovedReview(
          octokit as Parameters<typeof hasApprovedReview>[0],
          owner,
          repo,
          pullNumber,
          workflow_run.head_sha,
        ))
      ) {
        return;
      }

      const { config } = await loadReviewConfig(
        octokit as Parameters<typeof loadReviewConfig>[0],
        owner,
        repo,
        workflow_run.head_sha,
      );
      if (!config.review.auto_merge) return;

      await attemptAutoMergeApprovedPull(
        octokit as Parameters<typeof attemptAutoMergeApprovedPull>[0],
        owner,
        repo,
        {
          installationId: installation.id,
          repoFullName,
          pullNumber,
          headSha: workflow_run.head_sha,
        },
        config.review,
      );
    } catch (err) {
      captureException(err, {
        properties: {
          op: "auto_merge_after_workflow_run",
          repoFullName,
          pullNumber,
          runId: workflow_run.id,
        },
      });
    }
    return;
  }

  if (workflow_run.conclusion !== "failure") return;

  try {
    if (await recoveryIssueExists(octokit, owner, repo, workflow_run.html_url)) {
      return;
    }

    const failedJob = await findFailedWorkflowJob(octokit, owner, repo, workflow_run.id);
    const excerpt = failedJob
      ? await readFailureExcerpt(octokit, owner, repo, failedJob.id)
      : "No failing job log was available.";
    const branchName = workflow_run.head_branch ?? "unknown";
    const rootCauseGuess = guessRootCause(excerpt, failedJob?.name ?? workflow_run.name);
    const assignees = await resolveRecoveryAssignees(
      octokit,
      owner,
      repo,
      workflow_run.actor?.login ?? null,
    );

    await octokit.request("POST /repos/{owner}/{repo}/issues", {
      owner,
      repo,
      title: `CI recovery: ${failedJob?.name ?? workflow_run.name ?? "workflow"} failed on #${pullNumber}`,
      body: buildRecoveryIssueBody({
        pullNumber,
        branchName,
        failingJobName: failedJob?.name ?? workflow_run.name ?? "unknown",
        failingStepName: findFailingStepName(failedJob),
        logExcerpt: excerpt,
        rootCauseGuess,
        runUrl: workflow_run.html_url,
      }),
      labels: ["ci", "recovery"],
      ...(assignees.length ? { assignees } : {}),
    });

    track("system", "ci_recovery_issue_created", {
      repoFullName,
      pullNumber,
      branchName,
      runId: workflow_run.id,
      jobName: failedJob?.name,
    });
  } catch (err) {
    captureException(err, {
      properties: {
        op: "create_ci_recovery_issue",
        repoFullName,
        pullNumber,
        runId: workflow_run.id,
      },
    });
  }
}

async function recoveryIssueExists(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  runUrl: string,
): Promise<boolean> {
  const res = await octokit.request("GET /search/issues", {
    q: `repo:${owner}/${repo} is:issue "${runUrl}"`,
    per_page: 1,
  });
  return Number((res.data as { total_count?: number }).total_count ?? 0) > 0;
}

async function findFailedWorkflowJob(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowJob | null> {
  const res = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
    owner,
    repo,
    run_id: runId,
    per_page: 100,
  });
  const jobs = (res.data as { jobs?: WorkflowJob[] }).jobs ?? [];
  return jobs.find((job) => job.conclusion === "failure") ?? null;
}

async function readFailureExcerpt(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  jobId: number,
): Promise<string> {
  const res = await octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
    owner,
    repo,
    job_id: jobId,
  });
  const log =
    typeof res.data === "string" ? res.data : Buffer.from(res.data as ArrayBuffer).toString("utf8");
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstError = lines.findIndex((line) => /(^|\s)(error|failed|fatal):?/i.test(line));
  const start = firstError >= 0 ? Math.max(0, firstError - 2) : Math.max(0, lines.length - 12);
  return lines
    .slice(start, start + 12)
    .join("\n")
    .slice(0, 3_000);
}

async function resolveRecoveryAssignees(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  branchOwner: string | null,
): Promise<string[]> {
  if (branchOwner && (await isRepoCollaborator(octokit, owner, repo, branchOwner))) {
    return [branchOwner];
  }
  return env.CI_RECOVERY_FALLBACK_ASSIGNEE ? [env.CI_RECOVERY_FALLBACK_ASSIGNEE] : [];
}

async function isRepoCollaborator(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      {
        owner,
        repo,
        username,
      },
    );
    const permission = (res.data as { permission?: string }).permission;
    return ["admin", "maintain", "write"].includes(permission ?? "");
  } catch {
    return false;
  }
}

function findFailingStepName(job: WorkflowJob | null): string | null {
  return job?.steps?.find((step) => step.conclusion === "failure")?.name ?? null;
}

function guessRootCause(excerpt: string, jobName?: string | null): string {
  if (/module not found/i.test(excerpt)) {
    return "A required file or package is missing during the build.";
  }
  if (/frozen-lockfile|lockfile/i.test(excerpt)) {
    return "The dependency lockfile does not match the install inputs.";
  }
  if (/docker/i.test(jobName ?? "")) {
    return "The container build failed before the pull request could pass CI.";
  }
  return "The failing job log points to a CI setup or build failure.";
}

function buildRecoveryIssueBody(input: {
  pullNumber: number;
  branchName: string;
  failingJobName: string;
  failingStepName: string | null;
  logExcerpt: string;
  rootCauseGuess: string;
  runUrl: string;
}): string {
  const failingCheck = input.failingStepName
    ? `${input.failingJobName} / ${input.failingStepName}`
    : input.failingJobName;

  return [
    `PR: #${input.pullNumber}`,
    `Branch: ${input.branchName}`,
    `Failing check: ${failingCheck}`,
    `Run: ${input.runUrl}`,
    "",
    "Work on the pull request branch, not the default branch.",
    "",
    "Root-cause guess:",
    input.rootCauseGuess,
    "",
    "Log excerpt:",
    "```text",
    input.logExcerpt || "No failing job log was available.",
    "```",
  ].join("\n");
}
