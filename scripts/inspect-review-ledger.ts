import { Client } from "pg";
import { readAttemptReceiptPageSql } from "@/lib/job-attempt-receipts";
import { closeDb, getPool } from "@/lib/db";

/**
 * Operator inspection over an SSH console: prints recent review rows and, for
 * kind-blocking findings, the full finding identifiers that the approval
 * command requires. Check-run summaries truncate finding identifiers to
 * twelve characters, so this is the scriptable way to read the full value.
 * Read-only.
 */
export async function readAttemptReceipts(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--attempt-receipts" || !/^(0|[1-9][0-9]{0,18})$/.test(args[1]!)) {
    throw new Error("usage: --attempt-receipts <decimal receipt prefix>");
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000, query_timeout: 5000,
    options: "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=250" });
  try {
    await client.connect();
    const result = await client.query(readAttemptReceiptPageSql, [args[1]]);
    const output = JSON.stringify({ rows: result.rows });
    if (Buffer.byteLength(output) > 65536) throw new Error("receipt page exceeds response bound");
    console.log(output);
  } finally { await client.end(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length) { await readAttemptReceipts(args); return; }
  const pool = getPool();
  const reviews = await pool.query(
    `SELECT r.id, r.public_id, r.status, r.queued_at, r.started_at,
            r.finished_at, r.error_message,
            repo.full_name, r.pr_number, left(r.head_sha, 12) AS head,
            r.gate_check_run_id IS NOT NULL AS has_gate,
            COALESCE(
              (SELECT jsonb_agg(jsonb_build_object(
                        'id', finding->>'id',
                        'kind', finding->>'kind',
                        'severity', finding->>'severity',
                        'path', finding->>'path',
                        'title', finding->>'title'))
                 FROM jsonb_array_elements(COALESCE(r.envelope->'findings', '[]'::jsonb)) AS finding
                WHERE finding->>'kind' IN ('humanEscalation', 'guardrail')),
              '[]'::jsonb
            ) AS blocking_findings
       FROM reviews r
       JOIN repositories repo ON repo.id = r.repository_id
      WHERE r.queued_at > now() - interval '3 days'
      ORDER BY r.id`,
  );
  const approvals = await pool.query(
    `SELECT id, review_id, finding_id, actor_login_snapshot, revoked_at, created_at
       FROM finding_approvals
      ORDER BY id DESC
      LIMIT 20`,
  );
  console.log(
    JSON.stringify({ reviews: reviews.rows, approvals: approvals.rows }, null, 2),
  );
  await closeDb();
}

if (import.meta.main) main().catch(() => {
  console.error("review inspection unavailable");
  process.exit(1);
});
