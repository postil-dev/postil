import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

/**
 * Watchdog kill semantics against a real Postgres. The row's `startedAt`
 * clock starts before the CLI subprocess's own kill-timer does (token mint +
 * two check-run creates happen first), so a review can legitimately still be
 * completing when the watchdog's cutoff test says it's stuck. The guarded
 * `status = 'running'` update is the compare-and-swap that must let only one
 * side win; the loser must not call the GitHub API a second time for the
 * same check-runs. Set POSTIL_TEST_DATABASE_URL to run; skipped otherwise.
 */

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

let tokenCalls = 0;
let failCheckRunsCalls = 0;

// Spread the real module: `@/lib/github/checks` (pulled in transitively via
// `./respond`) imports `apiBase` from this same module, so a bare override
// object missing it breaks that unrelated import chain.
const realAppAuth = await import("@/lib/github/app-auth");
mock.module("@/lib/github/app-auth", () => ({
  ...realAppAuth,
  getInstallationToken: async () => {
    tokenCalls++;
    return "ghs_test_token";
  },
}));

// Spread the real module here too: `./respond` (pulled in transitively)
// imports `resolveLlmConfig`/`runCli` from the same file.
const realReview = await import("@/worker/review");
mock.module("@/worker/review", () => ({
  ...realReview,
  failCheckRuns: async () => {
    failCheckRunsCalls++;
  },
}));

process.env.DATABASE_URL = TEST_URL;

const schemaModule = await import("@/lib/db/schema");
const schema = schemaModule;
const { watchdogPass } = await import("@/worker/watchdog");

describeDb("watchdog stuck-review kill", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 8 });
    const dir = join(import.meta.dir, "..", "drizzle");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sqlText = await readFile(join(dir, file), "utf8");
      for (const statement of sqlText.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (!trimmed) continue;
        try {
          await pool.query(trimmed);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "42P07" && code !== "42710") throw err;
        }
      }
    }
  });

  beforeEach(async () => {
    tokenCalls = 0;
    failCheckRunsCalls = 0;
    await pool.query(
      "TRUNCATE private_worker_rehearsals, respond_deliveries, jobs RESTART IDENTITY",
    );
    await pool.query(
      "TRUNCATE reviews, repositories, installations, organizations RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedRepo(): Promise<number> {
    const org = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('octo', 'octo', 999) RETURNING id",
    );
    const inst = await pool.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, org_id, account_login, account_type, suspended)
       VALUES (42, $1, 'octo', 'Organization', false) RETURNING id`,
      [org.rows[0]!.id],
    );
    const repo = await pool.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, 7777, 'octo/repo', false, true) RETURNING id`,
      [inst.rows[0]!.id],
    );
    return Number(repo.rows[0]!.id);
  }

  async function seedStuckReview(
    repositoryId: number,
    startedAt = new Date(Date.now() - 20 * 60 * 1000),
  ): Promise<number> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status, started_at)
       VALUES ($1, 1, 'head', 'base', 'running', $2) RETURNING id`,
      [repositoryId, startedAt],
    );
    return Number(row.rows[0]!.id);
  }

  async function reviewStatus(reviewId: number): Promise<string> {
    const row = await pool.query<{ status: string }>("SELECT status FROM reviews WHERE id = $1", [
      reviewId,
    ]);
    return row.rows[0]!.status;
  }

  test("kills a review stuck past the deadline and completes its check-runs once", async () => {
    const repositoryId = await seedRepo();
    const now = new Date("2026-07-10T12:20:00.000Z");
    const startedAt = new Date("2026-07-10T12:00:00.000Z");
    const reviewId = await seedStuckReview(repositoryId, startedAt);

    const result = await watchdogPass(now);

    expect(result.killed).toBe(1);
    expect(await reviewStatus(reviewId)).toBe("failed");
    expect(tokenCalls).toBe(0);
    expect(failCheckRunsCalls).toBe(0);
    const cleanup = await pool.query<{ kind: string; payload: Record<string, unknown> }>(
      "SELECT kind, payload FROM jobs",
    );
    expect(cleanup.rows).toHaveLength(1);
    expect(cleanup.rows[0]!.kind).toBe("check-run-cleanup");
    expect(cleanup.rows[0]!.payload).toMatchObject({
      installationId: 42,
      repoFullName: "octo/repo",
      headSha: "head",
      advisoryCheckRunMayExist: true,
      message: expect.stringContaining("watchdog:"),
    });
    const timestamps = await pool.query<{
      started_at: Date;
      finished_at: Date;
      error_message: string;
    }>("SELECT started_at, finished_at, error_message FROM reviews WHERE id = $1", [reviewId]);
    expect(timestamps.rows[0]!.started_at).toEqual(startedAt);
    expect(timestamps.rows[0]!.finished_at).toEqual(now);
    expect(timestamps.rows[0]!.error_message).toContain("after 20m 0s of worker runtime");
  });

  test("does not touch a review that is no longer running", async () => {
    const repositoryId = await seedRepo();
    const reviewId = await seedStuckReview(repositoryId);
    // Simulate the worker completing normally between the deadline passing
    // and the watchdog pass running.
    await pool.query("UPDATE reviews SET status = 'completed' WHERE id = $1", [reviewId]);

    const result = await watchdogPass();

    expect(result.killed).toBe(0);
    expect(await reviewStatus(reviewId)).toBe("completed");
    expect(tokenCalls).toBe(0);
    expect(failCheckRunsCalls).toBe(0);
  });

  test("does not fail a staged publication while its exact checks are reconciled", async () => {
    const repositoryId = await seedRepo();
    const reviewId = await seedStuckReview(repositoryId);
    await pool.query(
      `UPDATE reviews
          SET envelope = '{"version":1,"findings":[],"gate":{"failing":false}}'::jsonb
        WHERE id = $1`,
      [reviewId],
    );

    const result = await watchdogPass();

    expect(result.killed).toBe(0);
    expect(await reviewStatus(reviewId)).toBe("running");
    const cleanup = await pool.query(
      "SELECT id FROM jobs WHERE kind = 'check-run-cleanup'",
    );
    expect(cleanup.rows).toHaveLength(0);
  });

  test("two concurrent passes over the same stuck review only kill it once", async () => {
    const repositoryId = await seedRepo();
    await seedStuckReview(repositoryId);

    // Two genuinely concurrent watchdog passes racing the same row: the
    // guarded `status = 'running'` update must let exactly one win.
    const [a, b] = await Promise.all([watchdogPass(), watchdogPass()]);

    expect(a.killed + b.killed).toBe(1);
    expect(tokenCalls).toBe(0);
    expect(failCheckRunsCalls).toBe(0);
    const cleanup = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE kind = 'check-run-cleanup'",
    );
    expect(cleanup.rows[0]!.count).toBe("1");
  });

  test("recovers every stuck row before durable check-run cleanup", async () => {
    const repositoryId = await seedRepo();
    const firstReviewId = await seedStuckReview(repositoryId);
    const secondReviewId = await seedStuckReview(repositoryId);
    const stuckJob = await pool.query<{ id: string }>(`
      INSERT INTO jobs (kind, payload, status, attempts, max_attempts, locked_at, locked_by)
      VALUES ('review', '{}', 'running', 1, 3, now() - interval '20 minutes', 'dead-worker')
      RETURNING id
    `);
    const result = await watchdogPass(new Date());

    expect(result.killed).toBe(2);
    expect(await reviewStatus(firstReviewId)).toBe("failed");
    expect(await reviewStatus(secondReviewId)).toBe("failed");
    const job = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
      stuckJob.rows[0]!.id,
    ]);
    expect(job.rows[0]!.status).toBe("queued");
    const cleanups = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE kind = 'check-run-cleanup'",
    );
    expect(cleanups.rows[0]!.count).toBe("2");
  });

  test("durably queues an exhausted respond job comment without external I/O", async () => {
    await pool.query(`
      INSERT INTO jobs (kind, payload, status, attempts, max_attempts, locked_at, locked_by)
      VALUES (
        'respond',
        '{"installationId":42,"repoFullName":"octo/repo","number":1}',
        'running', 3, 3, now() - interval '20 minutes', 'dead-worker'
      )
    `);
    const failedAfter = new Date();
    const first = await watchdogPass(failedAfter);
    const second = await watchdogPass(new Date());

    expect(first.killed).toBe(0);
    expect(second.killed).toBe(0);
    const jobs = await pool.query<{
      id: string;
      kind: string;
      status: string;
      run_after: Date;
      payload: Record<string, unknown>;
    }>(
      "SELECT id, kind, status, run_after, payload FROM jobs ORDER BY id",
    );
    expect(jobs.rows.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "respond", status: "failed" },
      { kind: "respond-failure-comment", status: "queued" },
    ]);
    expect(jobs.rows[1]!.payload.respondJobId).toBe(Number(jobs.rows[0]!.id));
    expect(jobs.rows[0]!.run_after.getTime()).toBeGreaterThanOrEqual(failedAfter.getTime());
  });

  test("requeues exhausted gate reconciliation until GitHub is synchronized", async () => {
    await pool.query(`
      INSERT INTO jobs (kind, payload, status, attempts, max_attempts, locked_at, locked_by)
      VALUES (
        'gate-state-sync',
        '{"reviewId":7,"reviewPublicId":"00000000-0000-4000-8000-000000000007"}',
        'running', 5, 5, now() - interval '20 minutes', 'dead-worker'
      )
    `);

    await watchdogPass(new Date());

    const job = await pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE kind = 'gate-state-sync'",
    );
    expect(job.rows[0]?.status).toBe("queued");
  });

  test("requeues exhausted check cleanup until both checks are terminal", async () => {
    await pool.query(`
      INSERT INTO jobs (kind, payload, status, attempts, max_attempts, locked_at, locked_by)
      VALUES (
        'check-run-cleanup',
        '{"installationId":42,"repoFullName":"octo/repo","advisoryCheckRunId":101,"gateCheckRunId":102,"message":"GitHub 503"}',
        'running', 5, 5, now() - interval '20 minutes', 'dead-worker'
      )
    `);

    await watchdogPass(new Date());

    const job = await pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE kind = 'check-run-cleanup'",
    );
    expect(job.rows[0]?.status).toBe("queued");
  });

  test("requeues exhausted durable webhook work until its side effects complete", async () => {
    await pool.query(`
      INSERT INTO jobs (kind, payload, status, attempts, max_attempts, locked_at, locked_by)
      VALUES
        (
          'webhook-dispatch', '{"deliveryId":"delivery-7"}',
          'running', 5, 5, now() - interval '20 minutes', 'dead-worker'
        ),
        (
          'webhook-comment',
          '{"installationId":42,"repoFullName":"octo/repo","number":7,"body":"reply","sourceDeliveryId":"delivery-8"}',
          'running', 5, 5, now() - interval '20 minutes', 'dead-worker'
        ),
        (
          'github-reaction',
          '{"installationId":42,"repoFullName":"octo/repo","commentId":9,"sourceDeliveryId":"delivery-9"}',
          'running', 5, 5, now() - interval '20 minutes', 'dead-worker'
        )
    `);

    await watchdogPass(new Date());

    const jobs = await pool.query<{ kind: string; status: string }>(
      `SELECT kind, status
         FROM jobs
        WHERE kind IN ('webhook-dispatch', 'webhook-comment', 'github-reaction')
        ORDER BY kind`,
    );
    expect(jobs.rows).toEqual([
      { kind: "github-reaction", status: "queued" },
      { kind: "webhook-comment", status: "queued" },
      { kind: "webhook-dispatch", status: "queued" },
    ]);
  });

  test("a review within the deadline is left alone", async () => {
    const repositoryId = await seedRepo();
    const row = await pool.query<{ id: string }>(
      `INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status, started_at)
       VALUES ($1, 2, 'head2', 'base2', 'running', now()) RETURNING id`,
      [repositoryId],
    );
    const reviewId = Number(row.rows[0]!.id);

    const result = await watchdogPass();

    expect(result.killed).toBe(0);
    expect(await reviewStatus(reviewId)).toBe("running");
    expect(tokenCalls).toBe(0);
  });
});
