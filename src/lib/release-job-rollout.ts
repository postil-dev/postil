import type { Pool } from "pg";

export const RELEASE_V1_JOB_KINDS = [
  "billing-contact-verification",
  "respond-delivery",
  "webhook-comment",
] as const;

const CAPABILITY = "release-v1-jobs";
const ADVISORY_LOCK_NAME = "postil:release-v1-jobs";

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
