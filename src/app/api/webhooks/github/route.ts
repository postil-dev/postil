import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { enqueueReviewPullRequest } from "@/jobs/review-pull-request";
import { attemptAutoMergeApprovedPull, hasApprovedReview } from "@/jobs/run-review";
import { loadReviewConfig } from "@/lib/config";
import { env } from "@/lib/env";
import { installationOctokit } from "@/lib/github";
import { captureException, track } from "@/lib/posthog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    await handlePullRequest(db, payload, deliveryId);
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

type WorkflowRunPayload = {
  action: string;
  workflow_run: {
    id: number;
    name?: string | null;
    conclusion?: string | null;
    html_url: string;
    head_branch?: string | null;
    head_sha?: string | null;
    actor?: { login?: string | null } | null;
    pull_requests?: Array<{ number: number }>;
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

  const reviewRow = await db
    .insert(schema.reviews)
    .values({
      installationId: installation.id,
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
    checkRunId = existing?.checkRunId ?? undefined;
  }

  if (!reviewId) {
    throw new Error("failed to initialize review row");
  }

  if (!checkRunId) {
    // Create an in-progress check-run so the PR shows "postil/review" immediately.
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
    const triggerRun = await enqueueReviewPullRequest(
      {
        installationId: installation.id,
        repoFullName,
        pullNumber,
        headSha,
        checkRunId,
        reviewId,
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
        installationId: installation.id,
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
        const octokit = await installationOctokit(installation.id);
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
  const { action, workflow_run, repository, installation } = p;
  if (!installation) return;
  if (action !== "completed") return;

  const pullNumber = workflow_run.pull_requests?.[0]?.number;
  if (!pullNumber) return;

  const repoFullName = repository.full_name;
  const [owner, repo] = repoFullName.split("/");
  const octokit = (await installationOctokit(installation.id)) as MinimalOctokit;

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
