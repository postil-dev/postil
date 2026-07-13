import type { Pool, PoolClient } from "pg";

const RETIRED_KINDS = [
  "escalation-notification",
  "escalation-email-verification",
] as const;
const LOCK_NAME = "postil:retire-escalation-email";

export interface EscalationEmailRetirementResult {
  running: number;
  terminalized: number;
  redacted: number;
  clearedOrganizations: number;
}

interface QuiesceOptions {
  timeoutMs?: number;
  pollMs?: number;
  onWait?: (running: number) => void;
}

export async function quiesceEscalationEmailJobs(
  pool: Pool,
  options: QuiesceOptions = {},
): Promise<EscalationEmailRetirementResult> {
  const result = await withRetirementLock(pool, async (client) => {
    await client.query(
      `UPDATE jobs
       SET run_after = 'infinity'::timestamptz
       WHERE kind = ANY($1::text[]) AND status = 'queued'`,
      [RETIRED_KINDS],
    );
    const running = await runningCount(client);
    return { running, terminalized: 0, redacted: 0, clearedOrganizations: 0 };
  });
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000);
  const pollMs = Math.max(10, options.pollMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  let running = result.running;
  while (running > 0 && Date.now() < deadline) {
    options.onWait?.(running);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    running = await runningCount(pool);
  }
  if (running > 0) {
    throw new Error(`${running} retired escalation email job(s) are still running after drain`);
  }
  return { ...result, running };
}

export async function finalizeEscalationEmailRetirement(
  pool: Pool,
): Promise<EscalationEmailRetirementResult> {
  return withRetirementLock(pool, async (client) => {
    const running = await runningCount(client);
    if (running > 0) {
      throw new Error(
        `${running} retired escalation email job(s) are still running after fleet replacement`,
      );
    }
    const terminalized = await client.query(
      `UPDATE jobs
       SET status = 'done',
           run_after = now(),
           locked_at = NULL,
           locked_by = NULL,
           last_error = NULL
       WHERE kind = ANY($1::text[]) AND status = 'queued'`,
      [RETIRED_KINDS],
    );
    const redacted = await client.query(
      `UPDATE jobs
       SET payload = '{"retired":true,"reason":"human escalation uses the pull request gate"}'::jsonb
       WHERE kind = ANY($1::text[])
         AND payload <> '{"retired":true,"reason":"human escalation uses the pull request gate"}'::jsonb`,
      [RETIRED_KINDS],
    );
    const cleared = await client.query(
      `UPDATE org_settings
       SET escalation_email = NULL,
           escalation_email_pending = NULL,
           escalation_email_verified_at = NULL,
           escalation_email_verification_token_digest = NULL,
           escalation_email_verification_token_ciphertext = NULL,
           escalation_email_verification_expires_at = NULL,
           escalation_email_verification_requested_at = NULL,
           escalation_email_verification_sent_at = NULL,
           escalation_email_verification_message_id = NULL
       WHERE escalation_email IS NOT NULL
          OR escalation_email_pending IS NOT NULL
          OR escalation_email_verified_at IS NOT NULL
          OR escalation_email_verification_token_digest IS NOT NULL
          OR escalation_email_verification_token_ciphertext IS NOT NULL
          OR escalation_email_verification_expires_at IS NOT NULL
          OR escalation_email_verification_requested_at IS NOT NULL
          OR escalation_email_verification_sent_at IS NOT NULL
          OR escalation_email_verification_message_id IS NOT NULL`,
    );
    return {
      running,
      terminalized: terminalized.rowCount ?? 0,
      redacted: redacted.rowCount ?? 0,
      clearedOrganizations: cleared.rowCount ?? 0,
    };
  });
}

async function runningCount(client: Pick<PoolClient, "query">): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM jobs
     WHERE kind = ANY($1::text[]) AND status = 'running'`,
    [RETIRED_KINDS],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function withRetirementLock<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      LOCK_NAME,
    ]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
