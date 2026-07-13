import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import { POST } from "@/app/api/webhooks/github/route";
import { signWebhookBody } from "@/lib/crypto/webhook";

/**
 * Webhook delivery dedupe durability (M1) against a real Postgres. The dedupe
 * row is committed before the handler dispatches its side effect; if dispatch
 * throws after the dedupe insert, the row MUST be rolled back so GitHub's
 * redelivery (same X-GitHub-Delivery) is reprocessed instead of being swallowed
 * as a duplicate. Set POSTIL_TEST_DATABASE_URL to run; skipped otherwise.
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
    const body = JSON.stringify({
      action: "opened",
      number: 7,
      installation: { id: 42 },
      repository: { id: 7777, full_name: "octo/repo", private: false },
      pull_request: { number: 7, head: { sha: "headsha" }, base: { sha: "basesha" } },
    });
    return new Request("https://postil.dev/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-hub-signature-256": signWebhookBody(body, WEBHOOK_SECRET),
        "x-github-delivery": DELIVERY_ID,
        "x-github-event": "pull_request",
        "content-type": "application/json",
      },
    });
  }

  test("dispatch failure rolls back the dedupe row so redelivery is reprocessed", async () => {
    // Break the side effect deterministically: quarantine the jobs table so the
    // enqueue inside handlePullRequest throws after the dedupe row is inserted.
    await pool.query("ALTER TABLE jobs RENAME TO jobs_quarantine");

    const failed = await POST(prRequest());
    // Non-2xx so GitHub retries.
    expect(failed.status).toBe(500);

    // The dedupe row MUST NOT survive a failed dispatch.
    const afterFail = await pool.query(
      "SELECT count(*)::int AS c FROM webhook_deliveries WHERE delivery_id = $1",
      [DELIVERY_ID],
    );
    expect(afterFail.rows[0].c).toBe(0);

    // GitHub redelivers the SAME delivery id; now the side effect can succeed.
    await pool.query("ALTER TABLE jobs_quarantine RENAME TO jobs");
    const ok = await POST(prRequest());
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok?: boolean; duplicate?: boolean };
    expect(okBody.ok).toBe(true);
    expect(okBody.duplicate).toBeUndefined();

    // Exactly one review job was enqueued (the redelivery, not a phantom from
    // the failed first attempt), and the dedupe row is now durably present.
    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]?.c).toBe(1);
    const dedupe = await pool.query(
      "SELECT count(*)::int AS c FROM webhook_deliveries WHERE delivery_id = $1",
      [DELIVERY_ID],
    );
    expect(dedupe.rows[0]?.c).toBe(1);
  });

  test("a genuine duplicate delivery is still skipped (happy-path dedupe intact)", async () => {
    const first = await POST(prRequest());
    expect(first.status).toBe(200);
    expect(((await first.json()) as { duplicate?: boolean }).duplicate).toBeUndefined();

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
});
