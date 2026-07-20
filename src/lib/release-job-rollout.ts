import type { Pool } from "pg";

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
export const HOSTED_INFERENCE_LOCK = "postil:hosted-inference-release";
export const HOSTED_TRIALS_PER_GITHUB_ACTOR = 3;

export function hostedInferenceCapability(releaseSha: string): string {
  const normalized = releaseSha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(normalized)) {
    throw new Error("hosted inference activation requires a release SHA");
  }
  return `${HOSTED_INFERENCE_CAPABILITY_PREFIX}${normalized}`;
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

/** Activate managed hosted inference for one exact release after its smoke test. */
export async function activateHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
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
      [hostedInferenceCapability(releaseSha)],
    );
    await client.query(
      `
      WITH hosted_counts AS (
        SELECT initiated_by_github_id, count(*)::int AS count
        FROM self_service_trial_grants
        WHERE granted_mode = 'hosted'
        GROUP BY initiated_by_github_id
      ), candidates AS (
        SELECT grant_row.org_id,
               row_number() OVER (
                 PARTITION BY grant_row.initiated_by_github_id
                 ORDER BY grant_row.created_at, grant_row.org_id
               ) AS candidate_rank,
               COALESCE(hosted_counts.count, 0) AS hosted_count
        FROM self_service_trial_grants grant_row
        JOIN organization_entitlements entitlement
          ON entitlement.org_id = grant_row.org_id
        LEFT JOIN org_settings settings
          ON settings.org_id = grant_row.org_id
        LEFT JOIN hosted_counts
          ON hosted_counts.initiated_by_github_id = grant_row.initiated_by_github_id
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
          AND candidates.candidate_rank <= GREATEST($1 - candidates.hosted_count, 0)
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
      [HOSTED_TRIALS_PER_GITHUB_ACTOR],
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
 * Report whether the target release is already active without changing any
 * capability. A failed or same-SHA deploy therefore preserves the last known
 * working release and an existing activation for the target SHA.
 */
export async function prepareHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  return hostedInferenceReleaseActivated(pool, releaseSha);
}

/** Explicitly revoke hosted inference for one exact release. */
export async function deactivateHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM deployment_capabilities WHERE name = $1",
    [hostedInferenceCapability(releaseSha)],
  );
  return (result.rowCount ?? 0) > 0;
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
