import { closeDb, getPool } from "@/lib/db";

/**
 * Operator inspection over an SSH console: prints recent review rows and, for
 * kind-blocking findings, the full finding identifiers that the approval
 * command requires. Check-run summaries truncate finding identifiers to
 * twelve characters, so this is the scriptable way to read the full value.
 * Read-only.
 */
async function main(): Promise<void> {
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
