import { and, eq, lt, sql } from "drizzle-orm";

import { getDb, getPool, schema } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
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
    await db
      .update(schema.reviews)
      .set({ status: "failed", errorMessage: message, finishedAt: now })
      .where(and(eq(schema.reviews.id, review.id), eq(schema.reviews.status, "running")));
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

  // Requeue or fail jobs whose worker died mid-run.
  const pool = getPool();
  await pool.query(
    `UPDATE jobs
     SET status = CASE WHEN attempts < max_attempts THEN 'queued'::job_status ELSE 'failed'::job_status END,
         locked_at = NULL, locked_by = NULL,
         last_error = COALESCE(last_error, '') || ' [watchdog: requeued stuck job]'
     WHERE status = 'running' AND locked_at < $1`,
    [cutoff],
  );

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
