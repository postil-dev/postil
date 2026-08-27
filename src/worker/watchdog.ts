import { and, eq, lt, sql } from "drizzle-orm";

import { getDb, getPool, schema, type Database } from "@/lib/db";
import { scheduleCustomerNotificationEmailJobs } from "@/lib/customer-notification-email";
import { pruneExpiredCustomerNotifications } from "@/lib/customer-notifications";
import { checkRunExternalId } from "@/lib/github/checks";
import { reviewDetailsUrl } from "@/lib/oauth";
import {
  COALESCED_REVIEW_PAYLOAD_KEY,
  PUBLICATION_RECONCILIATION_BUDGET_MS,
} from "@/lib/queue";
import {
  scheduleFindingFeedbackReconciliationJobs,
} from "@/lib/finding-feedback";
import {
  findingFeedbackDigestPeriodEnd,
  reconcileOperatorAlertDeliveries,
  scheduleFindingFeedbackDigest,
  sweepExpiredSelfServiceTrials,
} from "@/lib/operator-alerts";
import { scheduleBillingSettlementJobs } from "@/lib/paddle-billing";
import { REVIEW_DEADLINE_MS } from "./review";

export const WATCHDOG_ERROR_PREFIX = "watchdog:";

interface StuckReview {
  id: number;
  publicId: string;
  headSha: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  publicationLifecycleRequiredAt: Date | null;
  publicationLifecycleReconciledAt: Date | null;
  publicationStagedAt: Date | null;
  advisoryCheckRunId: number | null;
  gateCheckRunId: number | null;
  repoFullName: string;
  githubInstallationId: number;
  orgSlug: string | null;
}

const stuckReviewSelection = {
  id: schema.reviews.id,
  publicId: schema.reviews.publicId,
  headSha: schema.reviews.headSha,
  startedAt: schema.reviews.startedAt,
  finishedAt: schema.reviews.finishedAt,
  publicationLifecycleRequiredAt:
    schema.reviews.publicationLifecycleRequiredAt,
  publicationLifecycleReconciledAt:
    schema.reviews.publicationLifecycleReconciledAt,
  publicationStagedAt: schema.reviewPublicationReceipts.observedAt,
  advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
  gateCheckRunId: schema.reviews.gateCheckRunId,
  repoFullName: schema.repositories.fullName,
  githubInstallationId: schema.installations.githubInstallationId,
  orgSlug: schema.organizations.slug,
};

function stuckReviewQuery(db: Database) {
  return db
    .select(stuckReviewSelection)
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
    .leftJoin(
      schema.reviewPublicationReceipts,
      eq(schema.reviewPublicationReceipts.reviewId, schema.reviews.id),
    );
}

/**
 * Fail one `running` review closed: mark it failed and durably queue its
 * check-run completion (gate: policy outcome, review: failure). `returning()`
 * turns the status update into the compare-and-swap that decides a race with
 * a normal completion or a superseding push; the loser must not touch the
 * check-runs a second time.
 */
export async function failStuckReview(
  db: Database,
  review: StuckReview,
  message: string,
  now: Date,
  opts: {
    publicationIncomplete?: boolean;
    expectedStatus?: "running" | "completed";
  } = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.reviews)
      .set({ status: "failed", errorMessage: message, finishedAt: now })
      .where(
        and(
          eq(schema.reviews.id, review.id),
          eq(schema.reviews.status, opts.expectedStatus ?? "running"),
          ...(opts.expectedStatus === "completed"
            ? [
                sql`${schema.reviews.publicationLifecycleRequiredAt} IS NOT NULL`,
                sql`${schema.reviews.publicationLifecycleReconciledAt} IS NULL`,
              ]
            : []),
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
        advisoryCheckExternalId: checkRunExternalId(review.publicId, "review"),
        gateCheckExternalId: checkRunExternalId(review.publicId, "gate"),
        advisoryCheckRunMayExist: review.advisoryCheckRunId == null,
        gateCheckRunMayExist:
          review.gateCheckRunId == null && review.advisoryCheckRunId != null,
        message,
        detailsUrl: reviewDetailsUrl(review.publicId, review.orgSlug),
        ...(opts.publicationIncomplete ? { publicationIncomplete: true } : {}),
      },
      maxAttempts: 5,
    });
    return true;
  });
}

/**
 * Watchdog pass.
 *
 * 1. Reviews `running` past the deadline with no staged result are marked
 *    failed and their check-run completion durably queued. A review left
 *    in_progress forever is indistinguishable from a passing one in branch
 *    protection UIs; never leave one behind.
 * 2. Reviews `running` with a staged result (envelope present) whose
 *    publication has not reconciled within the reconciliation budget are
 *    also failed closed. Staging protects a result mid-reconciliation (see
 *    branch 1's `envelope IS NULL` guard), but that protection cannot be
 *    indefinite: a check-run GitHub will never report completed (the CLI
 *    declined to publish, or the forge outage outlasted the budget) would
 *    otherwise stay in_progress forever.
 * 3. Completed reviews whose thread lifecycle cannot reconcile within the
 *    publication budget are failed closed before their gate can publish.
 * 4. Jobs stuck `running` past the deadline (worker died mid-job) are
 *    requeued while attempts remain, else failed.
 */
export async function watchdogPass(
  now = new Date(),
): Promise<{ killed: number }> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - REVIEW_DEADLINE_MS);
  const reconciliationCutoff = new Date(
    now.getTime() - PUBLICATION_RECONCILIATION_BUDGET_MS,
  );

  const stuck = await stuckReviewQuery(db).where(
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
    if (await failStuckReview(db, review, message, now)) killed += 1;
  }

  const stuckPublications = await stuckReviewQuery(db).where(
    and(
      eq(schema.reviews.status, "running"),
      sql`${schema.reviews.envelope} IS NOT NULL`,
      lt(
        sql`COALESCE(${schema.reviewPublicationReceipts.observedAt}, ${schema.reviews.startedAt})`,
        reconciliationCutoff,
      ),
    ),
  );

  for (const review of stuckPublications) {
    const publicationStartedAt = review.publicationStagedAt ?? review.startedAt;
    const elapsedMs = publicationStartedAt
      ? Math.max(0, now.getTime() - publicationStartedAt.getTime())
      : 0;
    const message = `${WATCHDOG_ERROR_PREFIX} publication could not be verified within the ${PUBLICATION_RECONCILIATION_BUDGET_MS / 60000} minute reconciliation budget after ${formatElapsed(elapsedMs)} since staging`;
    if (
      await failStuckReview(db, review, message, now, {
        publicationIncomplete: true,
      })
    )
      killed += 1;
  }

  const stuckPublicationLifecycles = await stuckReviewQuery(db).where(
    and(
      eq(schema.reviews.status, "completed"),
      sql`${schema.reviews.publicationLifecycleRequiredAt} IS NOT NULL`,
      sql`${schema.reviews.publicationLifecycleReconciledAt} IS NULL`,
      lt(schema.reviews.finishedAt, reconciliationCutoff),
    ),
  );

  for (const review of stuckPublicationLifecycles) {
    const elapsedMs = review.finishedAt
      ? Math.max(0, now.getTime() - review.finishedAt.getTime())
      : 0;
    const message = `${WATCHDOG_ERROR_PREFIX} publication lifecycle could not reconcile within the ${PUBLICATION_RECONCILIATION_BUDGET_MS / 60000} minute reconciliation budget after ${formatElapsed(elapsedMs)}`;
    if (
      await failStuckReview(db, review, message, now, {
        publicationIncomplete: true,
        expectedStatus: "completed",
      })
    )
      killed += 1;
  }

  // Requeue or fail jobs whose worker died mid-run. A retained review request
  // replaces an abandoned pre-publication attempt with a fresh job that keeps
  // the configured retry budget.
  // Publication recovery remains on its original payload and promotes the
  // retained request only after that external reconciliation completes.
  // The data-modifying CTE
  // durably queues the user-facing reply for any respond job that exhausts
  // its retries here in the same statement. The conditional
  // `status = 'running'` guard means only this transition wins the row; the
  // runner's failJob would affect 0 rows and stay silent (no double-post).
  // Indefinite reconciliation jobs ignore max_attempts here because a dead
  // worker is not a handled attempt. Check-run cleanup is deliberately absent:
  // an ambiguous check-run can remain absent forever, so cleanup honors its
  // declared retry budget in both the runner and watchdog recovery paths.
  const pool = getPool();
  await pool.query(
    `WITH updated AS (
       UPDATE jobs
       SET status = CASE
             WHEN kind = 'review'
                  AND NOT payload ? 'recoveryReviewId'
                  AND jsonb_typeof(payload -> $2) = 'object'
               THEN 'failed'::job_status
             WHEN kind IN ('gate-state-sync', 'webhook-dispatch', 'webhook-comment', 'github-reaction')
                  OR (kind = 'review' AND payload ? 'recoveryReviewId')
                  OR attempts < max_attempts
               THEN 'queued'::job_status
             ELSE 'failed'::job_status
           END,
           locked_at = NULL, locked_by = NULL, run_after = now(),
           last_error = CASE
             WHEN kind = 'review'
                  AND NOT payload ? 'recoveryReviewId'
                  AND jsonb_typeof(payload -> $2) = 'object'
               THEN concat_ws(
                 ' ', NULLIF(last_error, ''),
                 '[watchdog: failed stuck job and retained newer review]'
               )
             ELSE COALESCE(last_error, '') ||
               CASE
                 WHEN kind IN ('gate-state-sync', 'webhook-dispatch', 'webhook-comment', 'github-reaction')
                      OR (kind = 'review' AND payload ? 'recoveryReviewId')
                      OR attempts < max_attempts
                   THEN ' [watchdog: requeued stuck job]'
                 ELSE ' [watchdog: failed stuck job after retry budget exhausted]'
               END
           END
       WHERE status = 'running' AND locked_at < $1
         AND NOT EXISTS (
           SELECT 1
             FROM private_worker_rehearsals rehearsal
            WHERE rehearsal.job_id = jobs.id
              AND rehearsal.state = 'awaiting_replacement'
         )
       RETURNING id, kind, status, payload, max_attempts
     )
     INSERT INTO jobs (kind, payload, max_attempts)
     SELECT
       'review',
       payload -> $2,
       max_attempts
     FROM updated
     WHERE kind = 'review'
       AND status = 'failed'
       AND jsonb_typeof(payload -> $2) = 'object'
     UNION ALL
     SELECT
       'respond-failure-comment',
       payload || jsonb_build_object('respondJobId', id),
       5
     FROM updated
     WHERE kind = 'respond' AND status = 'failed'`,
    [cutoff, COALESCED_REVIEW_PAYLOAD_KEY],
  );

  const scheduledFeedbackReconciliations = await scheduleFindingFeedbackReconciliationJobs(
    pool,
    now,
    findingFeedbackDigestPeriodEnd(now),
  );
  if (scheduledFeedbackReconciliations > 0) {
    console.log(`[finding feedback] scheduled=${scheduledFeedbackReconciliations}`);
  }

  await reconcileOperatorAlertDeliveries(db);
  const feedbackDigest = await scheduleFindingFeedbackDigest(db, now);
  if (feedbackDigest === "queued") console.log("[finding feedback] weekly digest queued");
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
  const customerEmail = await scheduleCustomerNotificationEmailJobs(db, now);
  if (customerEmail.queued > 0 || customerEmail.suppressed > 0) {
    console.log(
      `[customer email] queued=${customerEmail.queued} suppressed=${customerEmail.suppressed} events=${customerEmail.events}`,
    );
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
