import { and, eq, lt, sql } from "drizzle-orm";

import { getDb, getPool, schema } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import type { RespondJobPayload } from "@/lib/queue";
import { postRespondFailureComment } from "./respond";
import { REVIEW_DEADLINE_MS, failCheckRuns } from "./review";

export const WATCHDOG_ERROR_PREFIX = "watchdog:";

/**
 * Watchdog pass.
 *
 * 1. Reviews `running` past the deadline are marked failed and their
 *    check-runs completed (gate: failure, advisory: neutral). A review left
 *    in_progress forever is indistinguishable from a passing one in branch
 *    protection UIs; never leave one behind.
 * 2. Jobs stuck `running` past the deadline (worker died mid-job) are
 *    requeued while attempts remain, else failed.
 */
export async function watchdogPass(now = new Date()): Promise<{ killed: number }> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - REVIEW_DEADLINE_MS);

  const stuck = await db
    .select({
      id: schema.reviews.id,
      advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
      gateCheckRunId: schema.reviews.gateCheckRunId,
      repoFullName: schema.repositories.fullName,
      githubInstallationId: schema.installations.githubInstallationId,
    })
    .from(schema.reviews)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(and(eq(schema.reviews.status, "running"), lt(schema.reviews.startedAt, cutoff)));

  for (const review of stuck) {
    const message = `${WATCHDOG_ERROR_PREFIX} review exceeded ${REVIEW_DEADLINE_MS / 60000} minute deadline`;
    // The row's `startedAt` clock starts before the CLI subprocess's own
    // kill-timer does (token mint + two check-run creates happen first), so
    // there's a real window where this pass's cutoff test is true for a
    // review that is in fact about to complete normally. `returning()` turns
    // the update into the compare-and-swap that decides the race: if the
    // worker's own completion already flipped the status away from
    // `running`, this affects 0 rows and we must not touch its check-runs.
    const claimed = await db
      .update(schema.reviews)
      .set({ status: "failed", errorMessage: message, finishedAt: now })
      .where(and(eq(schema.reviews.id, review.id), eq(schema.reviews.status, "running")))
      .returning({ id: schema.reviews.id });
    if (claimed.length === 0) continue;
    try {
      const token = await getInstallationToken(review.githubInstallationId);
      await failCheckRuns(
        token,
        review.repoFullName,
        review.advisoryCheckRunId,
        review.gateCheckRunId,
        message,
      );
    } catch (err) {
      console.error(`watchdog: could not complete check-runs for review ${review.id}: ${err}`);
    }
  }

  // Requeue or fail jobs whose worker died mid-run. RETURNING tells us which
  // rows this pass moved to `failed`, so a respond job that exhausts its
  // retries here still gets the one user-facing reply. The conditional
  // `status = 'running'` guard means only this transition wins the row; the
  // runner's failJob would affect 0 rows and stay silent (no double-post).
  const pool = getPool();
  const updated = await pool.query<{ kind: string; status: string; payload: RespondJobPayload }>(
    `UPDATE jobs
     SET status = CASE WHEN attempts < max_attempts THEN 'queued'::job_status ELSE 'failed'::job_status END,
         locked_at = NULL, locked_by = NULL,
         last_error = COALESCE(last_error, '') || ' [watchdog: requeued stuck job]'
     WHERE status = 'running' AND locked_at < $1
     RETURNING kind, status, payload`,
    [cutoff],
  );
  for (const row of updated.rows) {
    if (row.kind === "respond" && row.status === "failed") {
      await postRespondFailureComment(row.payload);
    }
  }

  return { killed: stuck.length };
}

/** Total watchdog kills, derived from review error messages (cross-process safe). */
export async function watchdogKillCount(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.status, "failed"),
        sql`${schema.reviews.errorMessage} LIKE ${WATCHDOG_ERROR_PREFIX + "%"}`,
      ),
    );
  return rows[0]?.count ?? 0;
}
