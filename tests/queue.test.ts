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

  test("failJob {permanent} fails immediately without consuming remaining attempts", async () => {
    // A deterministic error (broken CA store, missing binary) must not burn the
    // retry budget: the very first attempt goes straight to `failed`.
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 3 });

    const job = await claimJob(pool, "w");
    expect(job?.attempts).toBe(1);
    expect(job?.maxAttempts).toBe(3);

    // attempts (1) < maxAttempts (3): the default path would requeue. The
    // permanent flag overrides that and performs the running -> failed flip.
    const outcome = await failJob(
      pool,
      job!,
      "No CA certificates were loaded from the system",
      { permanent: true },
    );
    expect(outcome).toBe("failed");

    const row = await pool.query("SELECT status, attempts, last_error FROM jobs WHERE id = $1", [
      job!.id,
    ]);
    expect(row.rows[0].status).toBe("failed");
    // Only the one attempt was consumed; the other two were skipped.
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].last_error).toContain("No CA certificates");
    expect(await claimJob(pool, "w")).toBeNull();
  });

  test("failJob {permanent} on an already-failed job returns 'lost' (single-post guard holds)", async () => {
    // The conditional running -> failed UPDATE is shared with the exhausted
    // path, so the permanent path also yields exactly one "failed" winner.
    await enqueueJob(pool, "respond", { n: 1 }, { maxAttempts: 3 });
    const job = await claimJob(pool, "w");

    expect(await failJob(pool, job!, "builder error", { permanent: true })).toBe("failed");
    expect(await failJob(pool, job!, "builder error", { permanent: true })).toBe("lost");

    const row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("failed");
  });

  test("a second failJob on an already-failed job returns 'lost' (single-post guard)", async () => {
    // The runner and the watchdog can both reach the final-fail path for the
    // same job. Only the call that performs the `running` -> `failed`
    // transition returns "failed" and owns the user-facing reply; a later
    // call sees the row already failed and returns "lost", so the reply is
    // posted at most once.
    await enqueueJob(pool, "respond", { n: 1 }, { maxAttempts: 1 });
    const job = await claimJob(pool, "w");
    expect(job?.attempts).toBe(1);

    expect(await failJob(pool, job!, "boom")).toBe("failed");
    let row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("failed");

    // Replaying the same final-fail (e.g. the other path) does not re-transition.
    expect(await failJob(pool, job!, "boom again")).toBe("lost");
    row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("failed");
  });

  test("failJob retry does not resurrect a job another worker re-claimed (returns 'lost')", async () => {
    // H1 race: worker W claims J; the job stalls past the watchdog deadline;
    // the watchdog requeues J; worker W2 re-claims and is now running J; then
    // W's late transient error reaches failJob's retry branch. Without the
    // `status='running' AND locked_by=$owner` guard, W would reset the running
    // row back to 'queued' and a third worker could run J concurrently with W2.
    // With the guard, W's retry matches 0 rows (W2 holds the lock under a new
    // attempt) and returns "lost", leaving W2's claim intact.
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 3 });

    const w1 = await claimJob(pool, "w1");
    expect(w1?.attempts).toBe(1);

    // Simulate the watchdog requeue: status back to 'queued', lock cleared.
    await pool.query(
      "UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = now() WHERE id = $1",
      [w1!.id],
    );

    // Worker W2 re-claims the same row; it is now 'running' under W2 (attempt 2).
    const w2 = await claimJob(pool, "w2");
    expect(w2?.id).toBe(w1?.id);
    expect(w2?.attempts).toBe(2);

    // W's late transient retry must NOT resurrect the row W2 now owns.
    expect(await failJob(pool, w1!, "late transient from w1")).toBe("lost");

    const row = await pool.query(
      "SELECT status, locked_by, attempts FROM jobs WHERE id = $1",
      [w1!.id],
    );
    // Still claimed-and-running under W2; not reset to 'queued'.
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].locked_by).toBe("w2");
    expect(row.rows[0].attempts).toBe(2);
    // The row is not re-claimable while W2 holds it (no second concurrent run).
    expect(await claimJob(pool, "w3")).toBeNull();
  });

  test("failJob retry still requeues when the caller still owns the running row", async () => {
    // Control for the guard above: the normal retry path (no intervening
    // re-claim) must keep working and return "retried".
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 3 });
    const job = await claimJob(pool, "w");
    expect(job?.attempts).toBe(1);
    expect(await failJob(pool, job!, "transient boom")).toBe("retried");
    const row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("queued");
  });

  test("completeJob does not stamp 'done' over a re-claimed running job", async () => {
    // Symmetric defense-in-depth: a worker finishing late must not mark a job
    // 'done' after the watchdog requeued it and another worker re-claimed it.
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 3 });
    const w1 = await claimJob(pool, "w1");

    // Watchdog requeue + W2 re-claim.
    await pool.query(
      "UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = now() WHERE id = $1",
      [w1!.id],
    );
    const w2 = await claimJob(pool, "w2");
    expect(w2?.id).toBe(w1?.id);

    // W1 completes late; the guard means it does not clobber W2's running claim.
    await completeJob(pool, w1!);
    const row = await pool.query("SELECT status, locked_by FROM jobs WHERE id = $1", [w1!.id]);
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].locked_by).toBe("w2");
  });

  test("completeJob marks the job done and releases the lock", async () => {
    await enqueueJob(pool, "review", { n: 1 });
    const job = await claimJob(pool, "w");
    await completeJob(pool, job!);
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
