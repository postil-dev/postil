import { and, eq, lt, sql } from "drizzle-orm";

import { getDb, getPool, schema } from "@/lib/db";
import { pruneExpiredCustomerNotifications } from "@/lib/customer-notifications";
import { checkRunExternalId } from "@/lib/github/checks";
import { reviewDetailsUrl } from "@/lib/oauth";
import {
  reconcileOperatorAlertDeliveries,
  sweepExpiredSelfServiceTrials,
} from "@/lib/operator-alerts";
import { scheduleBillingSettlementJobs } from "@/lib/paddle-billing";
import { REVIEW_DEADLINE_MS } from "./review";

export const WATCHDOG_ERROR_PREFIX = "watchdog:";

/**
 * Watchdog pass.
 *
 * 1. Reviews `running` past the deadline are marked failed and their
 *    check-run completion durably queued (gate: failure, advisory: neutral).
 *    A review left in_progress forever is indistinguishable from a passing
 *    one in branch protection UIs; never leave one behind.
 * 2. Jobs stuck `running` past the deadline (worker died mid-job) are
 *    requeued while attempts remain, else failed.
 */
export async function watchdogPass(
  now = new Date(),
): Promise<{ killed: number }> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - REVIEW_DEADLINE_MS);

  const stuck = await db
    .select({
      id: schema.reviews.id,
      publicId: schema.reviews.publicId,
      headSha: schema.reviews.headSha,
      startedAt: schema.reviews.startedAt,
      advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
      gateCheckRunId: schema.reviews.gateCheckRunId,
      repoFullName: schema.repositories.fullName,
      githubInstallationId: schema.installations.githubInstallationId,
      orgSlug: schema.organizations.slug,
    })
    .from(schema.reviews)
    .innerJoin(
      schema.repositories,
      eq(schema.repositories.id, schema.reviews.repositoryId),
    )
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .leftJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.installations.orgId),
    )
    .where(
      and(
        eq(schema.reviews.status, "running"),
        sql`${schema.reviews.envelope} IS NULL`,
        lt(schema.reviews.startedAt, cutoff),
      ),
    );

  let killed = 0;
  for (const review of stuck) {
    const elapsedMs = review.startedAt
      ? Math.max(0, now.getTime() - review.startedAt.getTime())
      : 0;
    const message = `${WATCHDOG_ERROR_PREFIX} review exceeded ${REVIEW_DEADLINE_MS / 60000} minute deadline after ${formatElapsed(elapsedMs)} of worker runtime`;
    // `returning()` turns the update into the compare-and-swap that decides
    // the race. A normal completion or superseding push that wins first means
    // this pass must not touch the check-runs.
    const claimed = await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.reviews)
        .set({ status: "failed", errorMessage: message, finishedAt: now })
        .where(
          and(
            eq(schema.reviews.id, review.id),
            eq(schema.reviews.status, "running"),
          ),
        )
        .returning({ id: schema.reviews.id });
      if (rows.length === 0) return false;
      await tx.insert(schema.jobs).values({
        kind: "check-run-cleanup",
        payload: {
          installationId: review.githubInstallationId,
          repoFullName: review.repoFullName,
          advisoryCheckRunId: review.advisoryCheckRunId,
          gateCheckRunId: review.gateCheckRunId,
          headSha: review.headSha,
          advisoryCheckExternalId: checkRunExternalId(
            review.publicId,
            "review",
          ),
          gateCheckExternalId: checkRunExternalId(review.publicId, "gate"),
          advisoryCheckRunMayExist: review.advisoryCheckRunId == null,
          gateCheckRunMayExist:
            review.gateCheckRunId == null && review.advisoryCheckRunId != null,
          message,
          detailsUrl: reviewDetailsUrl(review.publicId, review.orgSlug),
        },
        maxAttempts: 5,
      });
      return true;
    });
    if (claimed) killed += 1;
  }

  // Requeue or fail jobs whose worker died mid-run. The data-modifying CTE
  // durably queues the user-facing reply for any respond job that exhausts
  // its retries here in the same statement. The conditional
  // `status = 'running'` guard means only this transition wins the row; the
  // runner's failJob would affect 0 rows and stay silent (no double-post).
  // Reconciliation jobs ignore max_attempts here because a dead worker is not
  // a handled attempt. Their runner rejects malformed or impossible durable
  // state permanently and retries only recoverable delivery failures.
  const pool = getPool();
  await pool.query(
    `WITH updated AS (
       UPDATE jobs
       SET status = CASE
             WHEN kind IN ('gate-state-sync', 'check-run-cleanup', 'webhook-dispatch', 'webhook-comment', 'github-reaction')
                  OR (kind = 'review' AND payload ? 'recoveryReviewId')
                  OR attempts < max_attempts
               THEN 'queued'::job_status
             ELSE 'failed'::job_status
           END,
           locked_at = NULL, locked_by = NULL, run_after = now(),
           last_error = COALESCE(last_error, '') || ' [watchdog: requeued stuck job]'
       WHERE status = 'running' AND locked_at < $1
         AND NOT EXISTS (
           SELECT 1
             FROM private_worker_rehearsals rehearsal
            WHERE rehearsal.job_id = jobs.id
              AND rehearsal.state = 'awaiting_replacement'
         )
       RETURNING id, kind, status, payload
     )
     INSERT INTO jobs (kind, payload, max_attempts)
     SELECT
       'respond-failure-comment',
       payload || jsonb_build_object('respondJobId', id),
       5
     FROM updated
     WHERE kind = 'respond' AND status = 'failed'`,
    [cutoff],
  );

  await reconcileOperatorAlertDeliveries(db);
  const expiredTrials = await sweepExpiredSelfServiceTrials(db, now);
  if (expiredTrials.transitioned > 0) {
    console.log(
      `[trial expiry] transitioned=${expiredTrials.transitioned} alerted=${expiredTrials.alerted}`,
    );
  }
  const scheduledSettlements = await scheduleBillingSettlementJobs(db, now);
  if (scheduledSettlements > 0) {
    console.log(`[billing settlement] scheduled=${scheduledSettlements}`);
  }
  const prunedNotifications = await pruneExpiredCustomerNotifications(db, now);
  if (prunedNotifications > 0) {
    console.log(`[customer notifications] pruned=${prunedNotifications}`);
  }

  return { killed };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
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
