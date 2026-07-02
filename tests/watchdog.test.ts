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
    await pool.query("TRUNCATE jobs RESTART IDENTITY");
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

  async function seedStuckReview(repositoryId: number): Promise<number> {
    const startedAt = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago, past the 10-min deadline
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
    const reviewId = await seedStuckReview(repositoryId);

    const result = await watchdogPass();

    expect(result.killed).toBe(1);
    expect(await reviewStatus(reviewId)).toBe("failed");
    expect(tokenCalls).toBe(1);
    expect(failCheckRunsCalls).toBe(1);
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

  test("two concurrent passes over the same stuck review only kill it once", async () => {
    const repositoryId = await seedRepo();
    await seedStuckReview(repositoryId);

    // Two genuinely concurrent watchdog passes racing the same row: the
    // guarded `status = 'running'` update must let exactly one win.
    const [a, b] = await Promise.all([watchdogPass(), watchdogPass()]);

    expect(a.killed + b.killed).toBe(1);
    expect(tokenCalls).toBe(1);
    expect(failCheckRunsCalls).toBe(1);
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
