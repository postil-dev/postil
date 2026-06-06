import { and, eq, isNotNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { installationOctokit } from "@/lib/github";
import { captureException, track } from "@/lib/posthog";

const DEFAULT_STALE_AFTER_MS = 20 * 60 * 1000;
const DEFAULT_LIMIT = 25;

type StaleReview = {
  id: string;
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  checkRunId: number | null;
  createdAt: Date;
};

export type ReviewWatchdogResult = {
  scanned: number;
  completed: number;
  failed: number;
  cutoff: string;
};

function publicWatchdogMessage(): string {
  return "Review timed out before completion.";
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra) {
    throw new Error(`Invalid repo full name: ${repoFullName}`);
  }
  return { owner, repo };
}

async function failStaleReview(review: StaleReview): Promise<boolean> {
  if (!review.checkRunId) return false;

  const { owner, repo } = parseRepoFullName(review.repoFullName);
  const completedAt = new Date();
  const octokit = await installationOctokit(review.installationId);

  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: review.checkRunId,
    status: "completed",
    conclusion: "failure",
    completed_at: completedAt.toISOString(),
    output: {
      title: "Postil Review",
      summary: publicWatchdogMessage(),
      text: publicWatchdogMessage(),
    },
  });

  await getDb()
    .update(schema.reviews)
    .set({
      status: "failed",
      errorMessage: publicWatchdogMessage(),
      completedAt,
    })
    .where(and(eq(schema.reviews.id, review.id), eq(schema.reviews.status, "running")));

  track("system", "review_watchdog_completed_stale_check", {
    repoFullName: review.repoFullName,
    pullNumber: review.pullNumber,
    headSha: review.headSha,
    reviewId: review.id,
    checkRunId: review.checkRunId,
  });

  return true;
}

export async function completeStaleReviewCheckRuns(options?: {
  staleAfterMs?: number;
  limit?: number;
}): Promise<ReviewWatchdogResult> {
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const cutoff = new Date(Date.now() - staleAfterMs);

  const staleReviews = (await getDb()
    .select({
      id: schema.reviews.id,
      installationId: schema.reviews.installationId,
      repoFullName: schema.reviews.repoFullName,
      pullNumber: schema.reviews.pullNumber,
      headSha: schema.reviews.headSha,
      checkRunId: schema.reviews.checkRunId,
      createdAt: schema.reviews.createdAt,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.status, "running"),
        isNotNull(schema.reviews.checkRunId),
        lt(schema.reviews.createdAt, cutoff),
      ),
    )
    .limit(limit)) as StaleReview[];

  let completed = 0;
  let failed = 0;

  for (const review of staleReviews) {
    try {
      if (await failStaleReview(review)) completed += 1;
    } catch (err) {
      failed += 1;
      captureException(err, {
        properties: {
          op: "review_watchdog_complete_stale_check",
          repoFullName: review.repoFullName,
          pullNumber: review.pullNumber,
          headSha: review.headSha,
          reviewId: review.id,
          checkRunId: review.checkRunId,
        },
      });
    }
  }

  return {
    scanned: staleReviews.length,
    completed,
    failed,
    cutoff: cutoff.toISOString(),
  };
}
