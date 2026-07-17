import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import { POST } from "@/app/api/webhooks/github/route";
import { signWebhookBody } from "@/lib/crypto/webhook";
import { dispatchWebhookDelivery } from "@/lib/github/webhook-handler";
import {
  claimJob,
  enqueueRespondJobOnce,
  loadWebhookDelivery,
  pruneCompletedWebhookDeliveries,
} from "@/lib/queue";
import { drainQueueOnce, drainWebhookDispatch } from "@/worker/runner";

/**
 * Webhook inbox durability against a real Postgres. Acceptance commits the
 * signed payload and its retryable dispatch job atomically, then returns before
 * event processing. Set POSTIL_TEST_DATABASE_URL to run; skipped otherwise.
 */

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

const WEBHOOK_SECRET = "test-webhook-secret-for-dedupe";
const DELIVERY_ID = "00000000-dead-beef-0000-000000000001";

describeDb("webhook delivery dedupe durability", () => {
  let pool: Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "0";

    pool = new Pool({ connectionString: TEST_URL, max: 4 });
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
    // Restore the jobs table first if a prior test left it renamed.
    await pool.query("ALTER TABLE jobs_quarantine RENAME TO jobs").catch(() => undefined);
    // Clean slate, FK-safe order.
    await pool.query("TRUNCATE respond_deliveries, jobs RESTART IDENTITY");
    await pool.query("TRUNCATE webhook_deliveries");
    await pool.query(
      "TRUNCATE reviews, repositories, installations, organizations RESTART IDENTITY CASCADE",
    );

    // Seed an enabled, non-suspended installation + repository so a
    // pull_request 'opened' event reaches enqueueJob.
    const org = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('octo', 'octo', 999) RETURNING id",
    );
    const inst = await pool.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, org_id, account_login, account_type, suspended)
       VALUES (42, $1, 'octo', 'Organization', false) RETURNING id`,
      [org.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, 7777, 'octo/repo', false, true)`,
      [inst.rows[0]!.id],
    );
  });

  afterAll(async () => {
    await pool.query("ALTER TABLE jobs_quarantine RENAME TO jobs").catch(() => undefined);
    await pool?.end();
  });

  function prRequest(): Request {
    return signedRequest("pull_request", {
      action: "opened",
      number: 7,
      installation: { id: 42 },
      repository: { id: 7777, full_name: "octo/repo", private: false },
      pull_request: { number: 7, head: { sha: "headsha" }, base: { sha: "basesha" } },
    });
  }

  function commentRequest(body: string, pullRequest = true): Request {
    return signedRequest("issue_comment", {
      action: "created",
      installation: { id: 42 },
      repository: { id: 7777, full_name: "octo/repo", private: false },
      issue: { number: 7, ...(pullRequest ? { pull_request: {} } : {}) },
      comment: {
        body,
        author_association: "OWNER",
        user: { id: 100, login: "octocat", type: "User" },
      },
      sender: { id: 100, login: "octocat", type: "User" },
    });
  }

  function signedRequest(event: string, payload: object): Request {
    const body = JSON.stringify(payload);
    return new Request("https://postil.dev/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-hub-signature-256": signWebhookBody(body, WEBHOOK_SECRET),
        "x-github-delivery": DELIVERY_ID,
        "x-github-event": event,
        "content-type": "application/json",
      },
    });
  }

  test("prunes only completed delivery ids beyond the retention window", async () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    await pool.query(
      `INSERT INTO webhook_deliveries
         (delivery_id, event, payload, received_at, completed_at)
       VALUES
         ('expired', 'ping', NULL, $1, $1),
         ('recent', 'ping', NULL, $2, $2),
         ('pending', 'ping', '{}'::jsonb, $1, NULL)`,
      [new Date("2026-06-01T00:00:00.000Z"), new Date("2026-07-16T00:00:00.000Z")],
    );

    expect(await pruneCompletedWebhookDeliveries(pool, { now, batchSize: 1 })).toBe(1);
    const remaining = await pool.query<{ delivery_id: string }>(
      "SELECT delivery_id FROM webhook_deliveries ORDER BY delivery_id",
    );
    expect(remaining.rows.map((row) => row.delivery_id)).toEqual(["pending", "recent"]);
  });

  test("acceptance failure rolls back both the inbox row and dispatch job", async () => {
    // Break the atomic inbox transaction before either durable record commits.
    await pool.query("ALTER TABLE jobs RENAME TO jobs_quarantine");

    const failed = await POST(prRequest());
    // Non-2xx so GitHub retries.
    expect(failed.status).toBe(500);

    // The inbox row MUST NOT survive a failed acceptance.
    const afterFail = await pool.query(
      "SELECT count(*)::int AS c FROM webhook_deliveries WHERE delivery_id = $1",
      [DELIVERY_ID],
    );
    expect(afterFail.rows[0].c).toBe(0);

    // A manual redelivery of the same delivery id can now be accepted.
    await pool.query("ALTER TABLE jobs_quarantine RENAME TO jobs");
    const ok = await POST(prRequest());
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as {
      ok?: boolean;
      queued?: boolean;
      duplicate?: boolean;
    };
    expect(okBody.ok).toBe(true);
    expect(okBody.queued).toBe(true);
    expect(okBody.duplicate).toBeUndefined();

    expect(await drainQueueOnce("webhook-acceptance-test", { maxJobs: 1 })).toBe(1);

    // Exactly one review job was enqueued, and the retained payload was cleared
    // only after dispatch completed.
    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]?.c).toBe(1);
    const dedupe = await pool.query<{ completed: boolean; payload_cleared: boolean }>(
      `SELECT completed_at IS NOT NULL AS completed, payload IS NULL AS payload_cleared
         FROM webhook_deliveries WHERE delivery_id = $1`,
      [DELIVERY_ID],
    );
    expect(dedupe.rows[0]).toEqual({ completed: true, payload_cleared: true });
  });

  test("activated inbox rejects incomplete rows and retains accepted payloads", async () => {
    await expect(
      pool.query(
        `INSERT INTO webhook_deliveries (delivery_id, event, action)
         VALUES ('00000000-dead-beef-0000-000000000099', 'ping', NULL)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const accepted = await POST(prRequest());
    expect(accepted.status).toBe(200);
    const durable = await pool.query<{
      completed: boolean;
      payload_retained: boolean;
    }>(
      `SELECT completed_at IS NOT NULL AS completed, payload IS NOT NULL AS payload_retained
         FROM webhook_deliveries
        WHERE delivery_id = $1`,
      [DELIVERY_ID],
    );
    expect(durable.rows[0]).toEqual({ completed: false, payload_retained: true });
  });

  test("a genuine duplicate delivery is still skipped (happy-path dedupe intact)", async () => {
    const first = await POST(prRequest());
    expect(first.status).toBe(200);
    expect(((await first.json()) as { queued?: boolean }).queued).toBe(true);
    expect(await drainQueueOnce("webhook-duplicate-test", { maxJobs: 1 })).toBe(1);

    // Same delivery id again: acknowledged as duplicate, NOT reprocessed.
    const second = await POST(prRequest());
    expect(second.status).toBe(200);
    expect(((await second.json()) as { duplicate?: boolean }).duplicate).toBe(true);

    // Only one job despite two POSTs with the same delivery id.
    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]?.c).toBe(1);
  });

  test("a redelivery before dispatch reports the existing in-flight work", async () => {
    const first = await POST(prRequest());
    expect(first.status).toBe(200);
    expect(((await first.json()) as { queued?: boolean }).queued).toBe(true);

    const second = await POST(prRequest());
    expect(second.status).toBe(200);
    expect(((await second.json()) as { inflight?: boolean }).inflight).toBe(true);

    const dispatchJobs = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM jobs
        WHERE kind = 'webhook-dispatch'
          AND payload->>'deliveryId' = $1`,
      [DELIVERY_ID],
    );
    expect(dispatchJobs.rows[0]?.c).toBe(1);
  });

  test("an acknowledged delivery survives process handoff before dispatch", async () => {
    const accepted = await POST(prRequest());
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { queued?: boolean }).queued).toBe(true);

    const beforeDispatch = await pool.query<{
      payload_retained: boolean;
      completed: boolean;
      jobs: number;
    }>(
      `SELECT delivery.payload IS NOT NULL AS payload_retained,
              delivery.completed_at IS NOT NULL AS completed,
              count(job.id)::int AS jobs
         FROM webhook_deliveries delivery
         LEFT JOIN jobs job
           ON job.kind = 'webhook-dispatch'
          AND job.payload->>'deliveryId' = delivery.delivery_id
        WHERE delivery.delivery_id = $1
        GROUP BY delivery.delivery_id`,
      [DELIVERY_ID],
    );
    expect(beforeDispatch.rows[0]).toEqual({
      payload_retained: true,
      completed: false,
      jobs: 1,
    });

    // A different queue owner can finish the accepted work after the HTTP
    // process that committed it is gone.
    expect(await drainQueueOnce("webhook-handoff-test", { maxJobs: 1 })).toBe(1);
    const completed = await pool.query<{
      payload_cleared: boolean;
      completed: boolean;
    }>(
      `SELECT payload IS NULL AS payload_cleared, completed_at IS NOT NULL AS completed
         FROM webhook_deliveries WHERE delivery_id = $1`,
      [DELIVERY_ID],
    );
    expect(completed.rows[0]).toEqual({ payload_cleared: true, completed: true });
  });

  test("a dispatch claimed by a dead process is reclaimed and completed", async () => {
    const accepted = await POST(prRequest());
    expect(accepted.status).toBe(200);
    const abandoned = await claimJob(pool, "dead-web-process", ["webhook-dispatch"]);
    expect(abandoned?.kind).toBe("webhook-dispatch");
    await pool.query(
      "UPDATE jobs SET locked_at = now() - interval '1 day' WHERE id = $1",
      [abandoned!.id],
    );

    // drainQueueOnce runs the watchdog before claiming. The abandoned job is
    // returned to the queue and a new owner completes the retained payload.
    expect(await drainQueueOnce("webhook-reclaim-test", { maxJobs: 1 })).toBe(1);
    const result = await pool.query<{
      delivery_completed: boolean;
      job_status: string;
      attempts: number;
    }>(
      `SELECT delivery.completed_at IS NOT NULL AS delivery_completed,
              job.status::text AS job_status,
              job.attempts
         FROM webhook_deliveries delivery
         JOIN jobs job
           ON job.kind = 'webhook-dispatch'
          AND job.payload->>'deliveryId' = delivery.delivery_id
        WHERE delivery.delivery_id = $1`,
      [DELIVERY_ID],
    );
    expect(result.rows[0]).toEqual({
      delivery_completed: true,
      job_status: "done",
      attempts: 2,
    });
  });

  test("an orphaned dispatch fails permanently instead of retrying forever", async () => {
    expect((await POST(prRequest())).status).toBe(200);
    await pool.query("DELETE FROM webhook_deliveries WHERE delivery_id = $1", [DELIVERY_ID]);

    expect(await drainQueueOnce("webhook-orphan-test", { maxJobs: 1 })).toBe(1);
    const result = await pool.query<{ status: string; last_error: string }>(
      `SELECT status::text, last_error
         FROM jobs
        WHERE kind = 'webhook-dispatch'
          AND payload->>'deliveryId' = $1`,
      [DELIVERY_ID],
    );
    expect(result.rows[0]).toEqual({
      status: "failed",
      last_error: `webhook delivery ${DELIVERY_ID} is missing`,
    });
  });

  test("a crash after review enqueue does not enqueue the delivery twice", async () => {
    expect((await POST(prRequest())).status).toBe(200);
    const delivery = await loadWebhookDelivery(pool, DELIVERY_ID);
    expect(delivery).not.toBeNull();

    // Dispatch the side effect without completing the inbox row, matching a
    // process death after enqueue and before the completion update.
    await dispatchWebhookDelivery(delivery!.event, delivery!.payload, {
      deliveryId: DELIVERY_ID,
      triggerFollowupDrain: false,
    });
    expect(await drainWebhookDispatch(DELIVERY_ID, "review-crash-retry")).toBe(true);

    const jobs = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM jobs
        WHERE kind = 'review'
          AND payload->>'sourceDeliveryId' = $1`,
      [DELIVERY_ID],
    );
    expect(jobs.rows[0]?.c).toBe(1);
  });

  test("a crash after response enqueue does not run inference twice", async () => {
    expect((await POST(commentRequest("@postil what changed?"))).status).toBe(200);
    const delivery = await loadWebhookDelivery(pool, DELIVERY_ID);
    await dispatchWebhookDelivery(delivery!.event, delivery!.payload, {
      deliveryId: DELIVERY_ID,
      triggerFollowupDrain: false,
    });
    expect(await drainWebhookDispatch(DELIVERY_ID, "respond-crash-retry")).toBe(true);

    const jobs = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM jobs
        WHERE kind = 'respond'
          AND payload->>'sourceDeliveryId' = $1`,
      [DELIVERY_ID],
    );
    expect(jobs.rows[0]?.c).toBe(1);
  });

  test("fixed replies are queued once and never posted during webhook dispatch", async () => {
    expect((await POST(commentRequest("@postil review", false))).status).toBe(200);
    const delivery = await loadWebhookDelivery(pool, DELIVERY_ID);
    await dispatchWebhookDelivery(delivery!.event, delivery!.payload, {
      deliveryId: DELIVERY_ID,
      triggerFollowupDrain: false,
    });
    expect(await drainWebhookDispatch(DELIVERY_ID, "comment-crash-retry")).toBe(true);

    const jobs = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM jobs
        WHERE kind = 'webhook-comment'
          AND payload->>'sourceDeliveryId' = $1`,
      [DELIVERY_ID],
    );
    expect(jobs.rows[0]?.c).toBe(1);
  });

  test("concurrent dispatch attempts serialize source-delivery dedupe", async () => {
    const payload = {
      installationId: 42,
      repoFullName: "octo/repo",
      number: 7,
      isPr: true,
      comment: "@postil what changed?",
      sourceDeliveryId: DELIVERY_ID,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => enqueueRespondJobOnce(pool, payload)),
    );
    expect(results.filter((id) => id !== null)).toHaveLength(1);

    const jobs = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM jobs
        WHERE kind = 'respond'
          AND payload->>'sourceDeliveryId' = $1`,
      [DELIVERY_ID],
    );
    expect(jobs.rows[0]?.c).toBe(1);
  });

  test("source-delivery dedupe survives terminal downstream job states", async () => {
    const payload = {
      installationId: 42,
      repoFullName: "octo/repo",
      number: 7,
      isPr: true,
      comment: "@postil what changed?",
      sourceDeliveryId: DELIVERY_ID,
    };
    const jobId = await enqueueRespondJobOnce(pool, payload);
    expect(jobId).not.toBeNull();

    for (const status of ["done", "failed"] as const) {
      await pool.query("UPDATE jobs SET status = $1 WHERE id = $2", [status, jobId]);
      expect(await enqueueRespondJobOnce(pool, payload)).toBeNull();
    }

    const jobs = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM jobs
        WHERE kind = 'respond'
          AND payload->>'sourceDeliveryId' = $1`,
      [DELIVERY_ID],
    );
    expect(jobs.rows[0]?.c).toBe(1);
  });
});
