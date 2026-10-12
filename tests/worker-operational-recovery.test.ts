import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema, type Database } from "@/lib/db";
import type { Envelope } from "@/lib/envelope";
import { failJob, PermanentJobError } from "@/lib/queue";
import { parsePublicationReceipt } from "@/lib/publication-receipt";
import {
  ingestCompletedHostedReview,
  failHostedReviewAttempt,
  settleFailedHostedReviewAttempt,
} from "@/worker/review";
import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";

const describeDb = process.env.POSTIL_TEST_DATABASE_URL ? describe : describe.skip;

function envelope(path = ".postil/provider"): Envelope {
  return {
    version: 1, summary: "Review unavailable", silent: false,
    findings: [{ id: "finding", path, line: 1, severity: "error", kind: "risk",
      confidence: 1, title: "Provider request failed", body: "Provider returned HTTP 409" }],
    resolved: [], counts: { info: 0, warn: 0, error: 1, suppressed: 0, ungrounded: 0 },
    confidenceBuckets: [0, 0, 0, 0, 1], gate: { failOn: "error", failing: true },
    modelUsed: "test/model", usage: { promptTokens: 10, completionTokens: 5 },
    usageAccountingComplete: true, durationMs: 1, baseSha: "base", headSha: "head", sinceSha: null,
  };
}

describeDb("worker operational attempt recovery", () => {
  let fixture: EphemeralDatabase;
  let db: Database;
  let orgId: number;
  let repositoryId: number;

  beforeAll(async () => {
    fixture = await createEphemeralDatabase("worker_operational_recovery");
    db = drizzle(fixture.pool, { schema });
    const org = await fixture.pool.query("INSERT INTO organizations (slug,name) VALUES ('recovery','Recovery') RETURNING id");
    orgId = Number(org.rows[0].id);
    const installation = await fixture.pool.query("INSERT INTO installations (github_installation_id,account_login,account_type,org_id) VALUES (1001,'recovery','Organization',$1) RETURNING id", [orgId]);
    const repo = await fixture.pool.query("INSERT INTO repositories (installation_id,github_repo_id,full_name,private,enabled) VALUES ($1,1002,'recovery/repo',true,true) RETURNING id", [installation.rows[0].id]);
    repositoryId = Number(repo.rows[0].id);
  }, 30_000);
  afterAll(async () => { await fixture?.drop(); });

  async function attempt() {
    const review = await fixture.pool.query("INSERT INTO reviews (repository_id,pr_number,head_sha,base_sha,status) VALUES ($1,1,'head','base','running') RETURNING id", [repositoryId]);
    const reviewId = Number(review.rows[0].id);
    const reservationId = crypto.randomUUID();
    await fixture.pool.query("INSERT INTO hosted_usage_reservations (id,org_id,review_id,operation,status,reserved_micros,expires_at) VALUES ($1,$2,$3,'review','active',1000,now()+interval '15 minutes')", [reservationId, orgId, reviewId]);
    return { reviewId, reservationId, repositoryId, triggerSource: "unknown" as const,
      usage: [{ orgId, repositoryId, billingScope: "private_hosted" as const, promptTokens: 10, completionTokens: 5, modelUsed: "test/model", costMicros: 100 }],
      usageAccountingComplete: true };
  }

  async function retain(reviewId: number, value: Envelope) {
    const ingested = ingestCompletedHostedReview({ exitCode: 1, stdout: JSON.stringify(value), stderr: "" });
    await failHostedReviewAttempt(db, { reviewId, envelope: ingested.envelope, errorMessage: "review unavailable" });
  }

  test("exit-one operational failures retain diagnostics without staging and exhaust three queue attempts", async () => {
    const job = await fixture.pool.query("INSERT INTO jobs (kind,payload,status,attempts,locked_by) VALUES ('review','{}','running',1,'recovery-worker') RETURNING id,max_attempts");
    expect(job.rows[0].max_attempts).toBe(3);
    for (let attempts = 1; attempts <= 3; attempts++) {
      const input = await attempt();
      await retain(input.reviewId, envelope());
      const retained = await fixture.pool.query("SELECT envelope,status FROM reviews WHERE id=$1", [input.reviewId]);
      expect(retained.rows[0].envelope.findings[0].body).toContain("409");
      expect(retained.rows[0].status).toBe("failed");
      expect((await fixture.pool.query("SELECT * FROM review_publication_receipts WHERE review_id=$1", [input.reviewId])).rowCount).toBe(0);
      await settleFailedHostedReviewAttempt(db, input, undefined);
      await fixture.pool.query("UPDATE jobs SET status='running',attempts=$2,locked_by='recovery-worker' WHERE id=$1", [job.rows[0].id, attempts]);
      expect(await failJob(fixture.pool, { id: Number(job.rows[0].id), attempts, maxAttempts: 3, lockedBy: "recovery-worker" }, "review unavailable")).toBe(attempts < 3 ? "retried" : "failed");
      expect((await fixture.pool.query("SELECT payload FROM jobs WHERE id=$1", [job.rows[0].id])).rows[0].payload.recoveryReviewId).toBeUndefined();
    }
  });

  test("a rejected receipt keeps completed inference evidence", async () => {
    const input = await attempt();
    await retain(input.reviewId, envelope("src/index.ts"));
    expect(() => parsePublicationReceipt({ version: 1, receiptId: "receipt", findings: [
      { findingId: "finding", initialOutcome: "inline", commentId: "1" },
      { findingId: "finding", initialOutcome: "resolved" },
    ] })).toThrow("duplicate finding identity");
    await settleFailedHostedReviewAttempt(db, input, undefined);
    const row = await fixture.pool.query("SELECT envelope FROM reviews WHERE id=$1", [input.reviewId]);
    expect(row.rows[0].envelope.usage.promptTokens).toBe(10);
    expect((await fixture.pool.query("SELECT actual_micros::integer AS actual_micros FROM hosted_usage_reservations WHERE id=$1", [input.reservationId])).rows[0].actual_micros).toBe(100);
  });

  for (const complete of [true, false]) {
    test(`${complete ? "exact" : "incomplete"} usage settles once before cached output retirement`, async () => {
      const input = { ...await attempt(), usageAccountingComplete: complete };
      let discarded = 0;
      const proxy = { async discardCompletedRun() {
        const row = await fixture.pool.query("SELECT status,actual_micros::integer AS actual_micros FROM hosted_usage_reservations WHERE id=$1", [input.reservationId]);
        expect(row.rows[0]).toEqual({ status: "reconciled", actual_micros: complete ? 100 : 1000 });
        discarded++;
      } };
      await settleFailedHostedReviewAttempt(db, input, proxy);
      await settleFailedHostedReviewAttempt(db, input, proxy);
      expect(discarded).toBe(2);
      const rows = await fixture.pool.query("SELECT cost_micros::integer AS cost_micros FROM usage_events WHERE review_id=$1", [input.reviewId]);
      expect(rows.rows.reduce((sum, row) => sum + row.cost_micros, 0)).toBe(complete ? 100 : 1000);
      expect(rows.rowCount).toBe(complete ? 1 : 2);
    });
  }

  test("unknown pricing stays conservatively charged", async () => {
    const input = await attempt();
    await settleFailedHostedReviewAttempt(db, { ...input, usage: [{ ...input.usage[0]!, costMicros: null }] }, undefined);
    expect((await fixture.pool.query("SELECT actual_micros::integer AS actual_micros FROM hosted_usage_reservations WHERE id=$1", [input.reservationId])).rows[0].actual_micros).toBe(1000);
  });

  test("BYOK usage survives receipt failures without duplicate events", async () => {
    const input = await attempt();
    const byok = { ...input, reservationId: null, usage: input.usage.map((usage) => ({ ...usage, billingScope: "analytics" as const })) };
    await Promise.all([settleFailedHostedReviewAttempt(db, byok, undefined), settleFailedHostedReviewAttempt(db, byok, undefined)]);
    const events = await fixture.pool.query("SELECT cost_micros::integer AS cost_micros,billing_scope FROM usage_events WHERE review_id=$1", [input.reviewId]);
    expect(events.rows).toEqual([{ cost_micros: 100, billing_scope: "analytics" }]);
  });

  test("settlement failure prevents cache discard and stops unsafe retries", async () => {
    const input = await attempt();
    let discarded = false;
    await expect(settleFailedHostedReviewAttempt(db, { ...input, reviewId: input.reviewId + 1000000 }, {
      async discardCompletedRun() { discarded = true; },
    })).rejects.toBeInstanceOf(PermanentJobError);
    expect(discarded).toBe(false);
    expect((await fixture.pool.query("SELECT status FROM hosted_usage_reservations WHERE id=$1", [input.reservationId])).rows[0].status).toBe("active");
  });
});
