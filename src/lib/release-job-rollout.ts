import type { Pool, PoolClient } from "pg";

import { OPENROUTER_EXACT_LIMIT_MAX_MICROS } from "@/lib/openrouter-management-adapter";
import {
  HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
  type HostedProviderKeyLifecycleJobPayload,
} from "@/lib/queue";
import { HOSTED_REVIEW_UNAVAILABLE_MESSAGE } from "@/lib/review-outcome";

export const RELEASE_V1_JOB_KINDS = [
  "billing-contact-verification",
  "respond-delivery",
  "webhook-comment",
] as const;

const CAPABILITY = "release-v1-jobs";
const ADVISORY_LOCK_NAME = "postil:release-v1-jobs";
export const PRIVATE_REVIEW_AUTHOR_CAPABILITY = "private-review-author-v1";
const PRIVATE_REVIEW_AUTHOR_LOCK = "postil:private-review-author-v1";
const HOSTED_INFERENCE_CAPABILITY_PREFIX = "hosted-inference-release:";
const HOSTED_INFERENCE_DARK_PREFIX = "hosted-inference-dark:";
export const HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY =
  "hosted-inference-fleet-active";
export const HOSTED_INFERENCE_LOCK = "postil:hosted-inference-release";

function normalizedReleaseSha(releaseSha: string): string {
  const normalized = releaseSha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(normalized)) {
    throw new Error("hosted inference activation requires a release SHA");
  }
  return normalized;
}

export function hostedInferenceCapability(releaseSha: string): string {
  return `${HOSTED_INFERENCE_CAPABILITY_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

function hostedInferenceDarkCapability(releaseSha: string): string {
  return `${HOSTED_INFERENCE_DARK_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

/** A managed worker claimed hosted work before its exact release was activated. */
export class HostedInferenceReleaseDarkError extends Error {
  override name = "HostedInferenceReleaseDarkError";

  constructor(readonly releaseSha: string) {
    super("managed hosted inference release is awaiting activation");
  }
}

/** True only after this exact managed release passes its fleet and provider preflight. */
export async function hostedInferenceReleaseActivated(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const result = await pool.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS active`,
    [hostedInferenceCapability(releaseSha)],
  );
  return result.rows[0]?.active === true;
}

/**
 * Hold the activation lock while one bounded managed-provider operation runs.
 * Deploy activation and deactivation take the same lock, so provider access
 * cannot cross a release-dark transition.
 */
export async function withHostedInferenceReleaseActive<T>(
  pool: Pool,
  releaseSha: string,
  operation: () => Promise<T>,
): Promise<T> {
  const capability = hostedInferenceCapability(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const active = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AND EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $2
       ) AS active`,
      [capability, HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY],
    );
    if (active.rows[0]?.active !== true) {
      throw new HostedInferenceReleaseDarkError(releaseSha);
    }
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Activate managed hosted inference for one exact release after its smoke test. */
export async function activateHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const capability = hostedInferenceCapability(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const activated = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [capability],
    );
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET activated_at = now()`,
      [HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY],
    );
    await client.query(
      `
      WITH candidates AS (
        SELECT grant_row.org_id
        FROM self_service_trial_grants grant_row
        JOIN organization_entitlements entitlement
          ON entitlement.org_id = grant_row.org_id
        LEFT JOIN org_settings settings
          ON settings.org_id = grant_row.org_id
        WHERE grant_row.requested_mode = 'hosted'
          AND grant_row.granted_mode = 'byok'
          AND entitlement.subscription_mode = 'byok'
          AND entitlement.status = 'trialing'
          AND entitlement.updated_by = 'self-service-trial'
          AND entitlement.trial_ends_at > now()
          AND settings.api_key_ciphertext IS NULL
      ), promoted AS (
        UPDATE organization_entitlements entitlement
        SET subscription_mode = 'hosted',
            updated_by = 'hosted-release-activation',
            updated_at = now()
        FROM candidates
        WHERE entitlement.org_id = candidates.org_id
          AND entitlement.subscription_mode = 'byok'
          AND entitlement.status = 'trialing'
          AND entitlement.updated_by = 'self-service-trial'
          AND entitlement.trial_ends_at > now()
        RETURNING entitlement.org_id
      )
      UPDATE self_service_trial_grants grant_row
      SET granted_mode = 'hosted'
      FROM promoted
      WHERE grant_row.org_id = promoted.org_id
        AND grant_row.requested_mode = 'hosted'
        AND grant_row.granted_mode = 'byok'
    `,
    );
    await enqueueHostedProviderKeyLifecycleBackfill(client, releaseSha);
    const dark = await client.query<{ activated_at: Date }>(
      `SELECT min(activated_at) AS activated_at
         FROM deployment_capabilities
        WHERE name LIKE $1`,
      [`${HOSTED_INFERENCE_DARK_PREFIX}%`],
    );
    const darkStartedAt = dark.rows[0]?.activated_at;
    if (darkStartedAt) {
      // Reconcile automatic review requests recorded as unavailable inside the
      // durable dark window. Revive only the exact source job, and only when no
      // active or completed same-head review owns inference or publication.
      await client.query(
        `WITH candidates AS (
           SELECT job.id
             FROM jobs AS job
             JOIN repositories AS repository
               ON repository.github_repo_id::text = job.payload->>'githubRepoId'
              AND repository.installation_id::text =
                  job.payload->>'sourceInstallationId'
             JOIN reviews AS paused
               ON paused.repository_id = repository.id
              AND paused.pr_number::text = job.payload->>'prNumber'
              AND paused.head_sha = job.payload->>'headSha'
              AND paused.status = 'failed'
              AND paused.error_message = $2
              AND paused.trigger_source = 'automatic_pull_request'
              AND paused.trigger_context->>'webhookDeliveryId' =
                  job.payload->>'sourceDeliveryId'
            WHERE job.kind = 'review'
              AND job.status = 'done'
              AND job.created_at >= $1
              AND paused.finished_at >= $1
              AND job.payload#>>'{trigger,source}' = 'automatic_pull_request'
              AND NOT EXISTS (
                SELECT 1
                  FROM reviews AS owner
                 WHERE owner.repository_id = paused.repository_id
                   AND owner.pr_number = paused.pr_number
                   AND owner.head_sha = paused.head_sha
                   AND owner.status IN ('queued', 'running', 'completed')
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM jobs AS active
                 WHERE active.kind = 'review'
                   AND active.status IN ('queued', 'running')
                   AND active.id <> job.id
                   AND active.payload->>'githubRepoId' = job.payload->>'githubRepoId'
                   AND active.payload->>'prNumber' = job.payload->>'prNumber'
                   AND active.payload->>'headSha' = job.payload->>'headSha'
              )
            FOR UPDATE OF job SKIP LOCKED
         )
         UPDATE jobs AS job
            SET status = 'queued', attempts = 0, run_after = now(),
                locked_at = NULL, locked_by = NULL, last_error = NULL
           FROM candidates
          WHERE job.id = candidates.id`,
        [darkStartedAt, HOSTED_REVIEW_UNAVAILABLE_MESSAGE],
      );
    }
    await client.query(
      `UPDATE jobs
          SET run_after = now(),
              payload = payload - 'releaseDarkSha'
        WHERE kind IN ('review', $1)
          AND status = 'queued'
          AND run_after = 'infinity'::timestamptz
          AND payload ? 'releaseDarkSha'`,
      [HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND],
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE $1",
      [`${HOSTED_INFERENCE_DARK_PREFIX}%`],
    );
    await client.query("COMMIT");
    return (activated.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Deploy and rollback preparation always make the target release dark first. */
export async function deactivateHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const capability = hostedInferenceCapability(releaseSha);
  const darkCapability = hostedInferenceDarkCapability(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const result = await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [capability],
    );
    await client.query("DELETE FROM deployment_capabilities WHERE name = $1", [
      HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY,
    ]);
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [darkCapability],
    );
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Atomically park a claimed hosted review until a verified managed release activates. */
export async function deferHostedReviewForRelease(
  pool: Pool,
  job: { id: number; lockedBy: string },
  releaseSha: string,
): Promise<"deferred" | "released"> {
  return deferHostedJobForRelease(pool, job, releaseSha, "review");
}

/** Atomically park provider-key work until a verified managed release activates. */
export async function deferHostedProviderKeyLifecycleForRelease(
  pool: Pool,
  job: { id: number; lockedBy: string },
  releaseSha: string,
): Promise<"deferred" | "released"> {
  return deferHostedJobForRelease(
    pool,
    job,
    releaseSha,
    HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
  );
}

async function deferHostedJobForRelease(
  pool: Pool,
  job: { id: number; lockedBy: string },
  releaseSha: string,
  kind: "review" | typeof HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
): Promise<"deferred" | "released"> {
  const normalized = normalizedReleaseSha(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const active = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS active`,
      [HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY],
    );
    const activated = active.rows[0]?.active === true;
    const updated = await client.query(
      `UPDATE jobs
          SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
              run_after = CASE
                WHEN $3::boolean THEN now()
                ELSE 'infinity'::timestamptz
              END,
              locked_at = NULL, locked_by = NULL, last_error = NULL,
              payload = CASE
                WHEN $3::boolean THEN payload - 'releaseDarkSha'
                ELSE payload || jsonb_build_object('releaseDarkSha', $4::text)
              END
        WHERE id = $1 AND kind = $5
          AND status = 'running' AND locked_by = $2`,
      [job.id, job.lockedBy, activated, normalized, kind],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new Error("hosted review release deferral lost its queue claim");
    }
    await client.query("COMMIT");
    return activated ? "released" : "deferred";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function enqueueHostedProviderKeyLifecycleBackfill(
  client: Pick<PoolClient, "query">,
  releaseSha: string,
): Promise<void> {
  const payload = (orgId: string): HostedProviderKeyLifecycleJobPayload => ({
    orgId: Number(orgId),
    releaseSha: normalizedReleaseSha(releaseSha),
  });
  const candidates = await client.query<{ org_id: string }>(
    `SELECT DISTINCT candidate.org_id::text
       FROM (
         SELECT entitlement.org_id
           FROM organization_entitlements entitlement
          WHERE entitlement.subscription_mode = 'hosted'
            AND entitlement.status <> 'suspended'
            AND entitlement.period_starts_at <= clock_timestamp()
            AND entitlement.period_ends_at > clock_timestamp()
            AND entitlement.included_usage_micros
                + COALESCE(entitlement.overage_hard_cap_micros, 0) > 0
            AND entitlement.included_usage_micros
                + COALESCE(entitlement.overage_hard_cap_micros, 0) <= $1::bigint
            AND (
              entitlement.status = 'active'
              OR (
                entitlement.status = 'trialing'
                AND entitlement.trial_ends_at > clock_timestamp()
              )
              OR (
                entitlement.status = 'past_due'
                AND entitlement.past_due_grace_ends_at > clock_timestamp()
              )
              OR (
                entitlement.promotional_eligible
                AND (
                  entitlement.promotional_ends_at IS NULL
                  OR entitlement.promotional_ends_at > clock_timestamp()
                )
              )
            )
         UNION
         SELECT lifecycle.org_id
           FROM hosted_provider_keys lifecycle
          WHERE lifecycle.state NOT IN ('revoked', 'cancelled')
       ) candidate
      ORDER BY candidate.org_id::text`,
    [OPENROUTER_EXACT_LIMIT_MAX_MICROS.toString()],
  );
  for (const candidate of candidates.rows) {
    const jobPayload = payload(candidate.org_id);
    await client.query(
      `WITH active AS MATERIALIZED (
         SELECT id, status
           FROM jobs
          WHERE kind = $1
            AND status IN ('queued', 'running')
            AND payload->>'orgId' = $2
          ORDER BY id
          FOR UPDATE
       ), refreshed AS (
         UPDATE jobs job
            SET payload = $3::jsonb,
                run_after = CASE
                  WHEN job.status = 'queued' THEN now()
                  ELSE job.run_after
                END,
                last_error = NULL
          WHERE job.id IN (SELECT id FROM active)
        RETURNING job.id
       )
       INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT $1, $3::jsonb, 'queued', now(), 25
        WHERE NOT EXISTS (SELECT 1 FROM active)`,
      [
        HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
        candidate.org_id,
        JSON.stringify(jobPayload),
      ],
    );
  }
}

/** Activate private-review author enforcement after every managed process runs compatible code. */
export async function activatePrivateReviewAuthorIdentity(
  pool: Pool,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PRIVATE_REVIEW_AUTHOR_LOCK],
    );
    const anonymousActive = await client.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM reviews
         JOIN repositories ON repositories.id = reviews.repository_id
         WHERE repositories.private = true
           AND reviews.status IN ('queued', 'running')
           AND (
             reviews.author_github_id IS NULL
             OR reviews.author_github_id <= 0
             OR reviews.author_github_id > 9007199254740991
             OR reviews.author_login IS NULL
             OR length(btrim(reviews.author_login)) = 0
             OR length(reviews.author_login) > 100
           )
       ) AS blocked`,
    );
    if (anonymousActive.rows[0]?.blocked) {
      throw new Error(
        "private review author enforcement has anonymous active reviews",
      );
    }
    const activated = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [PRIVATE_REVIEW_AUTHOR_CAPABILITY],
    );
    await client.query("COMMIT");
    return (activated.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Activate new job consumers after the deploy has replaced every old
 * process. The migration's insert trigger takes the same transaction lock, so
 * no staged job can commit at infinity between this release UPDATE and
 * capability activation.
 */
export async function activateReleaseJobs(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [ADVISORY_LOCK_NAME],
    );
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [CAPABILITY],
    );
    const released = await client.query(
      `UPDATE jobs
       SET run_after = now()
       WHERE kind = ANY($1::text[])
         AND status = 'queued'
         AND run_after = 'infinity'::timestamptz`,
      [RELEASE_V1_JOB_KINDS],
    );
    await client.query("COMMIT");
    return released.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
