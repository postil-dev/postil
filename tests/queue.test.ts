import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool, type PoolClient } from "pg";

import {
  backoffMs,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  queueDepth,
} from "@/lib/queue";

/**
 * Queue claim semantics against a real Postgres (FOR UPDATE SKIP LOCKED
 * cannot be meaningfully unit-tested without one). Set
 * POSTIL_TEST_DATABASE_URL to run; the suite is skipped otherwise.
 */

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;

const describeDb = TEST_URL ? describe : describe.skip;

describeDb("postgres job queue", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 8 });
    // Apply the generated drizzle migration(s), tolerating reruns.
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
          // 42P07 duplicate table, 42710 duplicate object (enum/index).
          if (code !== "42P07" && code !== "42710") throw err;
        }
      }
    }
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE jobs RESTART IDENTITY");
  });

  afterAll(async () => {
    await pool?.end();
  });

  test("claim returns the oldest runnable job and marks it running", async () => {
    const id = await enqueueJob(pool, "review", { prNumber: 1 });
    const job = await claimJob(pool, "worker-a");
    expect(job).not.toBeNull();
    expect(job?.id).toBe(id);
    expect(job?.kind).toBe("review");
    expect(job?.payload).toEqual({ prNumber: 1 });
    expect(job?.attempts).toBe(1);

    const row = await pool.query(
      "SELECT status, locked_by FROM jobs WHERE id = $1",
      [id],
    );
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].locked_by).toBe("worker-a");
  });

  test("a locked row is skipped, not waited on (SKIP LOCKED)", async () => {
    const first = await enqueueJob(pool, "review", { n: 1 });
    const second = await enqueueJob(pool, "review", { n: 2 });

    // Hold a row lock on the first job in an open transaction.
    const holder: PoolClient = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [first]);

      // The claimer must skip the locked row and take the second job
      // immediately instead of blocking.
      const job = await claimJob(pool, "worker-b");
      expect(job?.id).toBe(second);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  test("two concurrent claims never take the same job", async () => {
    await enqueueJob(pool, "review", { n: 1 });
    await enqueueJob(pool, "review", { n: 2 });
    const [a, b] = await Promise.all([claimJob(pool, "w1"), claimJob(pool, "w2")]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
  });

  test("jobs scheduled in the future are not claimed", async () => {
    await enqueueJob(pool, "review", { n: 1 }, { runAfter: new Date(Date.now() + 60_000) });
    expect(await claimJob(pool, "w")).toBeNull();
    expect(await queueDepth(pool)).toBe(1);
  });

  test("failJob requeues with backoff until attempts are exhausted", async () => {
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 2 });

    const firstTry = await claimJob(pool, "w");
    expect(firstTry?.attempts).toBe(1);
    expect(await failJob(pool, firstTry!, "boom 1")).toBe("retried");

    let row = await pool.query("SELECT status, run_after > now() AS deferred, last_error FROM jobs");
    expect(row.rows[0].status).toBe("queued");
    expect(row.rows[0].deferred).toBe(true);
    expect(row.rows[0].last_error).toBe("boom 1");

    // Not claimable until the backoff elapses; pull it forward manually.
    expect(await claimJob(pool, "w")).toBeNull();
    await pool.query("UPDATE jobs SET run_after = now()");

    const secondTry = await claimJob(pool, "w");
    expect(secondTry?.attempts).toBe(2);
    expect(await failJob(pool, secondTry!, "boom 2")).toBe("failed");

    row = await pool.query("SELECT status FROM jobs");
    expect(row.rows[0].status).toBe("failed");
    expect(await claimJob(pool, "w")).toBeNull();
  });

  test("completeJob marks the job done and releases the lock", async () => {
    await enqueueJob(pool, "review", { n: 1 });
    const job = await claimJob(pool, "w");
    await completeJob(pool, job!.id);
    const row = await pool.query("SELECT status, locked_by FROM jobs");
    expect(row.rows[0].status).toBe("done");
    expect(row.rows[0].locked_by).toBeNull();
  });
});

describe("backoff schedule", () => {
  test("doubles per attempt and caps at 15 minutes", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(10)).toBe(15 * 60_000);
  });
});
