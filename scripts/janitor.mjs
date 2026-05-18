/**
 * Janitor: finalize stuck postil/review check-runs.
 *
 * Query the DB for reviews stuck in "running" for >15 minutes,
 * mark the GitHub check-run as failed/timed-out, and update the DB row.
 *
 * Run via:  node scripts/janitor.mjs
 * Env required: NEON_CONNECTION_STRING, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_B64 (or GITHUB_APP_PRIVATE_KEY)
 */
import { Client } from "pg";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

const CONN = process.env.NEON_CONNECTION_STRING;
const APP_ID = process.env.GITHUB_APP_ID;
const PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY_B64
  ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, "base64").toString("utf-8")
  : process.env.GITHUB_APP_PRIVATE_KEY;

if (!CONN || !APP_ID || !PRIVATE_KEY) {
  console.error("Missing required env vars: NEON_CONNECTION_STRING, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_B64/PRIVATE_KEY");
  process.exit(1);
}

const auth = createAppAuth({ appId: APP_ID, privateKey: PRIVATE_KEY });

function getOctokit(installationId) {
  return auth({ type: "installation", installationId }).then(({ token }) => new Octokit({ auth: token }));
}

const client = new Client({
  connectionString: CONN,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
const res = await client.query(
  `SELECT id, installation_id, repo_full_name, pull_number, head_sha, check_run_id, created_at
   FROM reviews
   WHERE status = 'running'
     AND created_at < NOW() - INTERVAL '15 minutes'`
);

let fixed = 0;
for (const row of res.rows) {
  if (!row.check_run_id) {
    console.log(`[skip] ${row.id}: no check_run_id`);
    continue;
  }
  const [owner, repo] = row.repo_full_name.split("/");
  try {
    const octokit = await getOctokit(Number(row.installation_id));
    await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner,
      repo,
      check_run_id: Number(row.check_run_id),
      status: "completed",
      conclusion: "failure",
      completed_at: new Date().toISOString(),
      output: {
        title: "Review timed out",
        summary: "Postil review did not complete within 15 minutes; janitor finalized the check-run. Investigate logs/traces for root cause.",
      },
    });
    await client.query(
      `UPDATE reviews
       SET status = 'failed',
           error_message = 'Janitor: timed out after 15 minutes',
           completed_at = NOW()
       WHERE id = $1`,
      [row.id]
    );
    console.log(`[fixed] ${row.repo_full_name}#${row.pull_number} check_run_id=${row.check_run_id}`);
    fixed++;
  } catch (err) {
    console.error(`[err] ${row.id}:`, err.message);
  }
}

await client.end();
console.log(`Done. Scanned ${res.rows.length}, fixed ${fixed}.`);
