import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendPreparedReceiptBatch, readAttemptReceiptPageSql, receiptAppendLockSql,
  receiptHeadSql, stageOwnedReviewSql, type PreparedReceipt, type ReceiptClient,
} from "../src/lib/job-attempt-receipts";

const port = process.env.POSTIL_RECEIPT_TEST_PORT;
type Rows = Record<string, any>[];
const connections: Array<{ close(): Promise<void> }> = [];
async function connect() {
  const pool = new SQL({ hostname: "localhost", port: Number(port), username: "postgres",
    database: process.env.POSTIL_RECEIPT_TEST_DATABASE ?? "postgres",
    max: 1, idleTimeout: 0, connectionTimeout: 2 });
  const reserved = await pool.reserve();
  let terminated = false;
  const client = {
    async query(text: string, values: unknown[] = []): Promise<{ rows: Rows }> {
      return { rows: Array.from(await reserved.unsafe(text, values as never[])) };
    },
    markTerminated() { terminated = true; },
    async close() {
      // A backend killed by a fault test has already closed its socket. Bun's
      // release of that dead reservation raises an unrelated teardown error.
      if (terminated) return;
      reserved.release(); await pool.close({ timeout: 0.1 });
    },
  };
  connections.push(client);
  return client;
}
let db: Awaited<ReturnType<typeof connect>>;
let repository: string;
const query = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows;
async function transaction<T>(client: ReceiptClient, body: () => Promise<T>): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try { const result = await body(); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}
async function job(kind = "review") {
  return (await query("INSERT INTO jobs(kind,payload) VALUES($1,'{}') RETURNING id::text", [kind]))[0]!.id as string;
}
function event(jobId: string, ordinal: number, claimId: string | null,
  changes: Partial<PreparedReceipt> = {}): PreparedReceipt {
  return { jobId, ordinal, jobKind: "review", claimId, reviewId: null,
    reviewPublicId: null, eventKind: "claim", outcome: "started", phase: null,
    category: null, recovered: null, recovery: null, ...changes };
}
async function claim(jobId: string, kind: "review" | "review-feedback" = "review") {
  return transaction(db, async () => {
    const rows = await query(`UPDATE jobs SET status='running', attempts=attempts+1,
      locked_by='fixture-worker', locked_at=now() WHERE id=$1::bigint AND status='queued'
      RETURNING attempts`, [jobId]);
    if (!rows.length) return null;
    const ordinal = rows[0]!.attempts as number;
    const [id] = await appendPreparedReceiptBatch(db, [event(jobId, ordinal, null, { jobKind: kind })]);
    await query("UPDATE jobs SET active_claim_receipt_id=$2::bigint WHERE id=$1::bigint", [jobId, id]);
    return { id: id!, ordinal, jobId, kind };
  });
}
type Claim = NonNullable<Awaited<ReturnType<typeof claim>>>;
async function closeClaim(c: Claim, outcome: PreparedReceipt["outcome"], reset = false) {
  return transaction(db, async () => {
    const rows = await query(`UPDATE jobs SET status=$3::job_status, active_claim_receipt_id=NULL,
      locked_by=NULL, locked_at=NULL, attempts=CASE WHEN $4 THEN 0 ELSE attempts END
      WHERE id=$1::bigint AND active_claim_receipt_id=$2::bigint AND status='running'
        AND locked_by='fixture-worker' RETURNING id`,
    [c.jobId, c.id, ["retry", "continued", "interrupted", "deferred"].includes(outcome) ? "queued" : "done", reset]);
    if (!rows.length) return false;
    await appendPreparedReceiptBatch(db, [event(c.jobId, c.ordinal, c.id,
      { jobKind: c.kind, eventKind: "queue_closed", outcome })]);
    return true;
  });
}
async function review(c: Claim) {
  return transaction(db, async () => {
    await query("SELECT id FROM jobs WHERE id=$1::bigint FOR UPDATE", [c.jobId]);
    const [r] = await query(`INSERT INTO reviews(repository_id,pr_number,head_sha,base_sha,status,origin_claim_receipt_id)
      VALUES($1::bigint,1,$2,$3,'running',$4::bigint) RETURNING id::text,public_id::text`,
    [repository, randomBytes(20).toString("hex"), randomBytes(20).toString("hex"), c.id]);
    await appendPreparedReceiptBatch(db, [event(c.jobId, c.ordinal, c.id,
      { jobKind: c.kind, eventKind: "review_bound", outcome: "bound", reviewId: r!.id, reviewPublicId: r!.public_id })]);
    return r!;
  });
}
async function observe(c: Claim, r: Record<string, any>, outcome: PreparedReceipt["outcome"]) {
  return transaction(db, async () => {
    const rows = await query(`UPDATE reviews SET status=$2::review_status
      WHERE id=$1::bigint AND status='running' RETURNING id`, [r.id, outcome === "staged" ? "running" : outcome]);
    if (!rows.length) return [];
    return appendPreparedReceiptBatch(db, [event(c.jobId, c.ordinal, c.id,
      { jobKind: c.kind, eventKind: "review_observed", outcome, reviewId: r.id, reviewPublicId: r.public_id })]);
  });
}
async function stage(c: Claim, r: Record<string, any>) {
  return transaction(db, async () => {
    await query("SELECT id FROM jobs WHERE id=$1::bigint FOR UPDATE", [c.jobId]);
    await query("SELECT id FROM reviews WHERE id=$1::bigint FOR UPDATE", [r.id]);
    return (await query(stageOwnedReviewSql, [c.jobId, c.id, "fixture-worker", r.id])).length;
  });
}

describe.skipIf(!port)("disposable PostgreSQL receipt SQL", () => {
  beforeAll(async () => {
    db = await connect();
    const [marker] = await query(`SELECT shobj_description(oid,'pg_database') AS marker
      FROM pg_database WHERE datname=current_database()`);
    if (marker?.marker !== "disposable receipt qualification") throw new Error("dedicated fixture required");
    const [installation] = await query(`INSERT INTO installations(github_installation_id,account_login,account_type)
      VALUES($1,'receipt-test','Organization') RETURNING id::text`, [Date.now()]);
    const [repo] = await query(`INSERT INTO repositories(installation_id,github_repo_id,full_name)
      VALUES($1::bigint,$2,'receipt-test/fixture') RETURNING id::text`, [installation!.id, Date.now()]);
    repository = repo!.id;
  });
  afterAll(async () => { await Promise.all(connections.map((c) => c.close())); });

  test("allocator is CACHE 1, positive, noncycling and rejects cache drift", async () => {
    const [s] = await query("SELECT seqcache::text,seqcycle,seqincrement::text FROM pg_sequence WHERE seqrelid='job_attempt_receipt_ids'::regclass");
    expect(s).toEqual({ seqcache: "1", seqcycle: false, seqincrement: "1" });
    await query("ALTER SEQUENCE job_attempt_receipt_ids CACHE 2");
    try { await expect(claim(await job())).rejects.toThrow(); }
    finally { await query("ALTER SEQUENCE job_attempt_receipt_ids CACHE 1"); }
  });

  test("same worker and reused ordinal cannot close or stage a newer claim", async () => {
    const j = await job(); const a = (await claim(j))!; const ra = await review(a);
    expect(await stage(a, ra)).toBe(1);
    expect(await closeClaim(a, "interrupted", true)).toBe(true);
    const b = (await claim(j))!; const rb = await review(b);
    expect(b.ordinal).toBe(a.ordinal); expect(b.id).not.toBe(a.id);
    expect(await stage(b, rb)).toBe(1);
    expect(await stage(a, ra)).toBe(0);
    expect(await closeClaim(a, "succeeded")).toBe(false);
    expect((await query("SELECT staged_review_id::text,active_claim_receipt_id::text,payload FROM jobs WHERE id=$1::bigint", [j]))[0])
      .toEqual({ staged_review_id: rb.id, active_claim_receipt_id: b.id, payload: { recoveryReviewId: Number(rb.id) } });
    // The genuine historical review can retain its own observation under A.
    expect((await observe(a, ra, "staged")).length).toBe(1);
    expect(await stage(a, rb)).toBe(0);
    expect(await closeClaim(b, "succeeded")).toBe(true);
    expect(await closeClaim(b, "succeeded")).toBe(false);
  });

  test("failure then success retains separate claims/reviews and finite incident", async () => {
    const j = await job("review-feedback"); const a = (await claim(j, "review-feedback"))!;
    const ra = await review(a);
    await transaction(db, async () => {
      await query("UPDATE reviews SET status='failed' WHERE id=$1::bigint", [ra.id]);
      await appendPreparedReceiptBatch(db, [
        event(j, a.ordinal, a.id, { jobKind: a.kind, eventKind: "incident", outcome: "observed",
          reviewId: ra.id, reviewPublicId: ra.public_id, phase: "review", category: "invalidOutput", recovered: false }),
        event(j, a.ordinal, a.id, { jobKind: a.kind, eventKind: "review_observed", outcome: "failed",
          reviewId: ra.id, reviewPublicId: ra.public_id }),
      ]);
    });
    expect(await closeClaim(a, "retry")).toBe(true);
    const b = (await claim(j, "review-feedback"))!; const rb = await review(b);
    await observe(b, rb, "completed"); expect(await closeClaim(b, "succeeded")).toBe(true);
    expect((await query("SELECT event_kind,outcome FROM job_attempt_receipts WHERE job_id=$1::bigint ORDER BY receipt_id", [j]))
      .map((r) => `${r.event_kind}:${r.outcome}`)).toEqual([
      "claim:started", "review_bound:bound", "incident:observed", "review_observed:failed", "queue_closed:retry",
      "claim:started", "review_bound:bound", "review_observed:completed", "queue_closed:succeeded",
    ]);
    expect((await observe(b, rb, "completed")).length).toBe(0);
  });

  test("append failure rolls business state back; aborted sequence gaps are safe", async () => {
    const j = await job(); const c = (await claim(j))!; const before = (await query(receiptHeadSql))[0]!.receipt_id;
    await expect(transaction(db, async () => {
      await query("UPDATE jobs SET status='done',active_claim_receipt_id=NULL WHERE id=$1::bigint", [j]);
      await appendPreparedReceiptBatch(db, [event(j, c.ordinal + 1, c.id, { eventKind: "queue_closed", outcome: "succeeded" })]);
    })).rejects.toThrow();
    expect((await query("SELECT status,active_claim_receipt_id::text FROM jobs WHERE id=$1::bigint", [j]))[0])
      .toEqual({ status: "running", active_claim_receipt_id: c.id });
    expect(await closeClaim(c, "succeeded")).toBe(true);
    const [last] = await query("SELECT r.receipt_id::text,r.predecessor_id::text FROM job_attempt_receipts r ORDER BY r.receipt_id DESC LIMIT 1");
    expect(last!.predecessor_id).toBe(before);
    expect(BigInt(last!.receipt_id) - BigInt(before)).toBeGreaterThan(1n);
  });

  test("publication recovery binds a new claim to the genuine staged review", async () => {
    const j = await job(); const a = (await claim(j))!; const r = await review(a);
    expect(await stage(a, r)).toBe(1); await closeClaim(a, "interrupted", true);
    const b = (await claim(j))!;
    await transaction(db, async () => {
      await query("SELECT id FROM jobs WHERE id=$1::bigint FOR UPDATE", [j]);
      await query("SELECT id FROM reviews WHERE id=$1::bigint FOR UPDATE", [r.id]);
      await appendPreparedReceiptBatch(db, [event(j, b.ordinal, b.id, { eventKind: "review_bound", outcome: "bound",
        reviewId: r.id, reviewPublicId: r.public_id })]);
    });
    expect(await stage(b, r)).toBe(1);
    expect((await query("SELECT origin_claim_receipt_id::text FROM reviews WHERE id=$1::bigint", [r.id]))[0]!.origin_claim_receipt_id).toBe(a.id);
    await observe(b, r, "completed"); await closeClaim(b, "succeeded");
  });

  test("constraints reject wrong job, wrong claim kind, missing binding and mutable origin", async () => {
    const a = (await claim(await job()))!; const b = (await claim(await job()))!; const r = await review(a);
    const invalid = [
      event(b.jobId, a.ordinal, a.id, { eventKind: "queue_closed", outcome: "succeeded" }),
      event(a.jobId, a.ordinal, a.id, { eventKind: "review_observed", outcome: "failed", reviewId: r.id, reviewPublicId: randomUUID() }),
      event(b.jobId, b.ordinal, b.id, { eventKind: "review_bound", outcome: "bound", reviewId: r.id, reviewPublicId: r.public_id }),
    ];
    for (const e of invalid) await expect(transaction(db, () => appendPreparedReceiptBatch(db, [e]))).rejects.toThrow();
    await expect(query("UPDATE reviews SET origin_claim_receipt_id=$2::bigint WHERE id=$1::bigint", [r.id, b.id])).rejects.toThrow();
    await expect(query("UPDATE job_attempt_receipts SET outcome=outcome WHERE receipt_id=$1::bigint", [a.id])).rejects.toThrow();
    await expect(query("DELETE FROM job_attempt_receipts WHERE receipt_id=$1::bigint", [a.id])).rejects.toThrow();
    await expect(query("TRUNCATE job_attempt_receipts CASCADE")).rejects.toThrow();
    const [binding] = await query("SELECT receipt_id::text FROM job_attempt_receipts WHERE claim_receipt_id=$1::bigint AND event_kind='review_bound'", [a.id]);
    await expect(transaction(db, () => appendPreparedReceiptBatch(db, [event(a.jobId, a.ordinal, binding!.receipt_id,
      { eventKind: "queue_closed", outcome: "succeeded" })]))).rejects.toThrow();
    expect(await closeClaim(a, "succeeded")).toBe(true);
    await expect(transaction(db, () => appendPreparedReceiptBatch(db, [event(a.jobId, a.ordinal, a.id,
      { eventKind: "queue_closed", outcome: "succeeded" })]))).rejects.toThrow();
  });

  test("claim history does not cascade or restrict synthetic business row deletion", async () => {
    const c = (await claim(await job()))!; const r = await review(c);
    await closeClaim(c, "succeeded");
    await query("DELETE FROM reviews WHERE id=$1::bigint", [r.id]);
    await query("DELETE FROM jobs WHERE id=$1::bigint", [c.jobId]);
    expect((await query("SELECT receipt_id FROM job_attempt_receipts WHERE job_id=$1::bigint", [c.jobId])).length).toBe(3);
  });

  test("delayed concurrent append uses a fresh predecessor after waiting", async () => {
    const a = await connect(); const b = await connect();
    const ja = await job(); const jb = await job();
    for (const [client, id] of [[a, ja], [b, jb]] as const) {
      await client.query("BEGIN");
      await client.query("UPDATE jobs SET status='running',attempts=1 WHERE id=$1::bigint", [id]);
    }
    const oldHead = (await b.query(receiptHeadSql)).rows[0]!.receipt_id;
    const [ia] = await appendPreparedReceiptBatch(a, [event(ja, 1, null)]);
    const pending = appendPreparedReceiptBatch(b, [event(jb, 1, null)]);
    await query("SELECT pg_sleep(0.05)");
    expect((await query(receiptHeadSql))[0]!.receipt_id).toBe(oldHead);
    expect((await query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=17491 AND NOT granted")).length).toBe(1);
    await a.query("COMMIT");
    const [ib] = await pending; await b.query("COMMIT");
    expect(BigInt(ib!)).toBeGreaterThan(BigInt(ia!));
    expect((await query("SELECT predecessor_id::text FROM job_attempt_receipts WHERE receipt_id=$1::bigint", [ib]))[0]!.predecessor_id).toBe(ia);
  });

  test("prepared multi-row batch is invisible until one commit", async () => {
    const writer = await connect(); const jobs = [await job(), await job()];
    await writer.query("BEGIN");
    for (const id of jobs) await writer.query("UPDATE jobs SET status='running',attempts=1 WHERE id=$1::bigint", [id]);
    const ids = await appendPreparedReceiptBatch(writer, jobs.map((id) => event(id, 1, null)));
    expect((await query("SELECT receipt_id FROM job_attempt_receipts WHERE job_id=ANY($1::bigint[])", ["{" + jobs.join(",") + "}"])).length).toBe(0);
    await writer.query("COMMIT");
    expect((await query("SELECT r.receipt_id::text FROM job_attempt_receipts r WHERE job_id=ANY($1::bigint[]) ORDER BY r.receipt_id", ["{" + jobs.join(",") + "}"])).map((r) => r.receipt_id)).toEqual(ids);
  });

  test("stalled writer has bounded wait; independent business work proceeds", async () => {
    const holder = await connect(); const waiter = await connect();
    await holder.query("BEGIN"); await holder.query(receiptAppendLockSql);
    await waiter.query("BEGIN"); await waiter.query("SET LOCAL lock_timeout='100ms'");
    const started = performance.now();
    await expect(waiter.query(receiptAppendLockSql)).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1500);
    await waiter.query("ROLLBACK");
    const j = await job();
    expect((await query("UPDATE jobs SET payload=payload || '{\"fixture\":true}'::jsonb WHERE id=$1::bigint RETURNING id", [j])).length).toBe(1);
    // A finite reader does not wait for the writer's advisory lock.
    expect((await query(readAttemptReceiptPageSql, ["0"])).length).toBeLessThanOrEqual(64);
    await holder.query("ROLLBACK");
    expect((await claim(j))!.id).toBeString();
  });

  test("backend death before commit rolls back state and releases append lock", async () => {
    const writer = await connect(); const j = await job();
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await writer.query("BEGIN");
    await writer.query("UPDATE jobs SET status='running',attempts=1 WHERE id=$1::bigint", [j]);
    const [id] = await appendPreparedReceiptBatch(writer, [event(j, 1, null)]);
    writer.markTerminated(); await query("SELECT pg_terminate_backend($1::integer, 1000)", [pid]);
    expect((await query("SELECT pid FROM pg_stat_activity WHERE pid=$1::integer", [pid])).length).toBe(0);
    expect((await query("SELECT status,attempts FROM jobs WHERE id=$1::bigint", [j]))[0]).toEqual({ status: "queued", attempts: 0 });
    expect((await query("SELECT receipt_id FROM job_attempt_receipts WHERE receipt_id=$1::bigint", [id])).length).toBe(0);
    expect((await claim(j))!.id).toBeString();
  });

  test("idle transaction expiry releases a stalled append tail", async () => {
    const writer = await connect();
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await writer.query("BEGIN"); await writer.query("SET LOCAL idle_in_transaction_session_timeout='100ms'");
    await writer.query(receiptAppendLockSql);
    writer.markTerminated();
    await query("SELECT pg_sleep(0.2)");
    expect((await query("SELECT pid FROM pg_stat_activity WHERE pid=$1::integer", [pid])).length).toBe(0);
    expect((await claim(await job()))!.id).toBeString();
  });

  test("backend death during COMMIT rolls back the deferred transaction", async () => {
    const c = (await claim(await job()))!; const writer = await connect();
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await query(`CREATE FUNCTION receipt_fixture_commit_pause() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
    await query(`CREATE CONSTRAINT TRIGGER receipt_fixture_commit_pause AFTER INSERT ON job_attempt_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.event_kind='queue_closed')
      EXECUTE FUNCTION receipt_fixture_commit_pause()`);
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE jobs SET status='done',active_claim_receipt_id=NULL WHERE id=$1::bigint", [c.jobId]);
      await appendPreparedReceiptBatch(writer, [event(c.jobId, c.ordinal, c.id, { eventKind: "queue_closed", outcome: "succeeded" })]);
      const committing = writer.query("COMMIT").then(() => true, () => false);
      await query("SELECT pg_sleep(0.05)");
      expect((await query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1::integer", [pid]))[0]!.wait_event).toBe("PgSleep");
      writer.markTerminated(); await query("SELECT pg_terminate_backend($1::integer)", [pid]);
      expect(await committing).toBe(false);
      expect((await query("SELECT status,active_claim_receipt_id::text FROM jobs WHERE id=$1::bigint", [c.jobId]))[0])
        .toEqual({ status: "running", active_claim_receipt_id: c.id });
      expect((await query("SELECT receipt_id FROM job_attempt_receipts WHERE claim_receipt_id=$1::bigint AND event_kind='queue_closed'", [c.id])).length).toBe(0);
    } finally {
      await query("DROP TRIGGER receipt_fixture_commit_pause ON job_attempt_receipts");
      await query("DROP FUNCTION receipt_fixture_commit_pause()");
    }
    expect(await closeClaim(c, "succeeded")).toBe(true);
    // Reconciliation after a committed transition returns no second occurrence.
    expect(await closeClaim(c, "succeeded")).toBe(false);
  });

  test("repeatable-read and autocommit cannot append authoritative receipts", async () => {
    const writer = await connect(); const j = await job();
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await expect(appendPreparedReceiptBatch(writer, [event(j, 1, null)])).rejects.toThrow();
    await writer.query("ROLLBACK");
    await expect(appendPreparedReceiptBatch(writer, [event(j, 1, null)])).rejects.toThrow();
  });

  test("reader lock timeout rolls back and releases its transaction", async () => {
    const holder = await connect(); const reader = await connect();
    const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await holder.query("BEGIN"); await holder.query("LOCK job_attempt_receipts IN ACCESS EXCLUSIVE MODE");
    await reader.query("BEGIN READ ONLY"); await reader.query("SET LOCAL lock_timeout='100ms'");
    const start = performance.now();
    await expect(reader.query(readAttemptReceiptPageSql, ["0"])).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(1500);
    await reader.query("ROLLBACK"); await holder.query("ROLLBACK");
    const [state] = await query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1::integer", [pid]);
    expect(state).toEqual({ state: "idle", xact_start: null });
    expect((await claim(await job()))!.id).toBeString();
  });

  test("legacy writers remain available and do not manufacture receipts", async () => {
    const j = await job();
    await query("UPDATE jobs SET status='running',attempts=attempts+1,locked_by='fixture-legacy' WHERE id=$1::bigint", [j]);
    await query("UPDATE jobs SET status='done',locked_by=NULL,last_error=NULL WHERE id=$1::bigint", [j]);
    expect((await query("SELECT receipt_id FROM job_attempt_receipts WHERE job_id=$1::bigint", [j])).length).toBe(0);
    const c = (await claim(await job()))!;
    // An old administrative writer can still transition a new claim; that
    // transition has no receipt and fleet completeness must remain unknown.
    await query("UPDATE jobs SET status='queued',locked_by=NULL WHERE id=$1::bigint", [c.jobId]);
    expect(await closeClaim(c, "succeeded")).toBe(false);
    expect((await query("SELECT receipt_id FROM job_attempt_receipts WHERE job_id=$1::bigint", [c.jobId])).length).toBe(1);
  });

  test("a crash between review and queue commits leaves a partial history", async () => {
    const c = (await claim(await job()))!; const r = await review(c);
    await observe(c, r, "failed");
    expect((await query("SELECT outcome FROM job_attempt_receipts WHERE job_id=$1::bigint AND event_kind='queue_closed'", [c.jobId])).length).toBe(0);
    expect((await query("SELECT status FROM jobs WHERE id=$1::bigint", [c.jobId]))[0]!.status).toBe("running");
    await closeClaim(c, "interrupted");
    expect((await query("SELECT outcome FROM job_attempt_receipts WHERE job_id=$1::bigint ORDER BY receipt_id", [c.jobId])).map((r) => r.outcome))
      .toEqual(["started", "bound", "failed", "interrupted"]);
  });

  test("append-only guard prevents suffix loss; a privileged loss is visible only when acknowledged", async () => {
    const c = (await claim(await job()))!; await closeClaim(c, "succeeded");
    const suffix = (await query(receiptHeadSql))[0]!.receipt_id;
    await expect(query("DELETE FROM job_attempt_receipts WHERE receipt_id=$1::bigint", [suffix])).rejects.toThrow();
    // Fault injection is restricted to the dedicated disposable database.
    await query("BEGIN");
    try {
      await query("ALTER TABLE job_attempt_receipts DISABLE TRIGGER job_attempt_receipts_immutable");
      await query("DELETE FROM job_attempt_receipts WHERE receipt_id=$1::bigint", [suffix]);
      const acknowledged = (await query(readAttemptReceiptPageSql, [suffix]))[0]!;
      expect(acknowledged.anchor_id).toBeNull();
      expect(BigInt(acknowledged.head_id)).toBeLessThan(BigInt(suffix));
      const unseen = (await query(readAttemptReceiptPageSql, [c.id]))[0]!;
      expect(unseen.anchor_id).toBe(c.id);
      expect(unseen.receipt_id).toBeNull();
      // An unseen suffix loss supplies no detectable discontinuity by itself.
    } finally { await query("ROLLBACK"); }
    expect((await query(receiptHeadSql))[0]!.receipt_id).toBe(suffix);
  });

  test("a simultaneous staging/reclaim race preserves the new target", async () => {
    const j = await job(); const a = (await claim(j))!; const ra = await review(a);
    await closeClaim(a, "interrupted", true);
    const b = (await claim(j))!; const rb = await review(b);
    const late = await connect(); const owner = await connect();
    await owner.query("BEGIN"); await owner.query("SELECT id FROM jobs WHERE id=$1::bigint FOR UPDATE", [j]);
    await owner.query(stageOwnedReviewSql, [j, b.id, "fixture-worker", rb.id]);
    await late.query("BEGIN");
    const pending = late.query(stageOwnedReviewSql, [j, a.id, "fixture-worker", ra.id]);
    await query("SELECT pg_sleep(0.05)"); await owner.query("COMMIT");
    expect((await pending).rows.length).toBe(0); await late.query("COMMIT");
    expect((await query("SELECT staged_review_id::text FROM jobs WHERE id=$1::bigint", [j]))[0]!.staged_review_id).toBe(rb.id);
  });

  test("seeded stateful histories preserve one closure and immutable claim fencing", async () => {
    let seed = 173;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const outcomes = ["retry", "continued", "interrupted", "deferred", "cancelled", "coalesced", "succeeded"] as const;
    for (let history = 0; history < 20; history++) {
      const j = await job(); const claims: Claim[] = [];
      for (let step = 0; step < 8; step++) {
        const c = (await claim(j))!; claims.push(c);
        for (const stale of claims.slice(0, -1)) expect(await closeClaim(stale, "succeeded")).toBe(false);
        const outcome = step === 7 ? "succeeded" : outcomes[random() % 4]!;
        expect(await closeClaim(c, outcome, Boolean(random() % 2))).toBe(true);
        expect(await closeClaim(c, outcome)).toBe(false);
      }
      expect(new Set(claims.map((c) => c.id)).size).toBe(8);
      expect((await query("SELECT receipt_id FROM job_attempt_receipts WHERE job_id=$1::bigint AND event_kind='queue_closed'", [j])).length).toBe(8);
    }
  }, 20000);

  test("privacy projection rejects getters and ignores generated hostile content", async () => {
    const j = await job(); const c = (await claim(j))!; const r = await review(c);
    let getterCalls = 0;
    const hostile = randomUUID() + '\n{"trusted":true,"jobId":"' + randomBytes(16).toString("hex") + '"}\u001b[2J';
    await query("UPDATE jobs SET payload=jsonb_build_object('message',$2::text),last_error=$2 WHERE id=$1::bigint", [j, hostile]);
    await query("UPDATE reviews SET error_message=$2,envelope=jsonb_build_object('modelOutput',$2::text) WHERE id=$1::bigint", [r.id, hostile]);
    const forged = event(j, 1, c.id);
    Object.defineProperty(forged, "outcome", { enumerable: true, get() { getterCalls++; return "started"; } });
    await expect(transaction(db, () => appendPreparedReceiptBatch(db, [forged]))).rejects.toThrow();
    expect(getterCalls).toBe(0);
    const anchor = (await query("SELECT predecessor_id::text FROM job_attempt_receipts WHERE receipt_id=$1::bigint", [c.id]))[0]!.predecessor_id;
    const page = await query(readAttemptReceiptPageSql, [anchor]);
    expect(page.some((row) => row.claim_receipt_id === c.id)).toBe(true);
    expect(page.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
    expect(JSON.stringify(page)).not.toContain(hostile);
    expect(Object.keys(page[0]!)).not.toContain("payload");
    expect(Object.keys(page[0]!)).not.toContain("error_message");
  });

  test("recovery semantics and repeated incidents are enforced in PostgreSQL", async () => {
    const c = (await claim(await job()))!; const r = await review(c);
    const incident = event(c.jobId, c.ordinal, c.id, { eventKind: "incident", outcome: "observed",
      reviewId: r.id, reviewPublicId: r.public_id, phase: "review", category: "invalidOutput", recovered: false });
    await expect(transaction(db, () => appendPreparedReceiptBatch(db, [{ ...incident, recovery: "repair" }]))).rejects.toThrow();
    await expect(transaction(db, () => appendPreparedReceiptBatch(db, [{ ...incident, recovered: true }]))).rejects.toThrow();
    const ids = await transaction(db, () => appendPreparedReceiptBatch(db, [incident, incident, { ...incident, recovered: true, recovery: "repair" }]));
    expect(new Set(ids).size).toBe(3);
  });

  test("large decimal identities retain numeric order and timestamps do not advance a cursor", async () => {
    const [floor] = await query(`SELECT setval('job_attempt_receipt_ids',
      GREATEST((SELECT receipt_id+1 FROM job_attempt_receipts ORDER BY receipt_id DESC LIMIT 1),9007199254740993),false)::text AS id`);
    await query("ALTER TABLE job_attempt_receipts ALTER COLUMN occurred_at SET DEFAULT '2030-01-01T00:00:00Z'");
    const a = (await claim(await job()))!; const b = (await claim(await job()))!;
    await query("ALTER TABLE job_attempt_receipts ALTER COLUMN occurred_at SET DEFAULT '2000-01-01T00:00:00Z'");
    let c: Claim;
    try { c = (await claim(await job()))!; }
    finally { await query("ALTER TABLE job_attempt_receipts ALTER COLUMN occurred_at SET DEFAULT clock_timestamp()"); }
    expect(a.id).toBe(floor!.id); expect(BigInt(b.id)).toBe(BigInt(a.id) + 1n);
    const rows = await query(readAttemptReceiptPageSql, [a.id]);
    expect(rows.map((r) => r.receipt_id)).toEqual([b.id, c!.id]);
    expect(rows[0]!.occurred_at.startsWith("2030-")).toBe(true);
    expect(rows[1]!.occurred_at.startsWith("2000-")).toBe(true);
    expect(rows[0]!.predecessor_id).toBe(a.id);
    // Reading and accepting a prefix are separate operations in this harness.
    const accepted = b.id;
    expect((await query(readAttemptReceiptPageSql, [accepted]))[0]!.receipt_id).toBe(c!.id);
    expect((await query(readAttemptReceiptPageSql, [a.id]))[0]!.receipt_id).toBe(b.id);
  });

  test("finite page has indexed range/genesis/anchor/backwards-head access", async () => {
    await query("ANALYZE job_attempt_receipts");
    const explain = await query("EXPLAIN (ANALYZE, FORMAT JSON) " + readAttemptReceiptPageSql, ["9007199254740993"]);
    const plan = JSON.stringify(explain);
    expect(plan).toContain("job_attempt_receipts_pkey");
    expect(plan).toContain("Index Cond");
    expect(plan).toContain("Backward");
    expect(plan).not.toContain("Seq Scan");
    expect((await query(readAttemptReceiptPageSql, ["0"])).length).toBe(64);
  });
});

// Production driver and API checks share only the explicitly marked fixture.
import { Pool } from "pg";
import { createServer, connect as connectSocket } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/lib/db/schema";
import {
  claimJob, completeJob, continueClaimedJob, failJob, requeueJobsOwnedBy,
  retryJobIndefinitely, externalSideEffectLeaseActive, cancelPullRequestPublication,
  type ClaimedJob,
} from "../src/lib/queue";
import {
  insertReviewForClaim, bindStagedReviewClaim, stageReviewCompletionCandidate,
  finalizeStagedReviewCompletionWithGateMode,
} from "../src/lib/review-completion";
import { claimPausedHostedReview } from "../src/lib/hosted-review-pause";
import { deferHostedReviewForRelease } from "../src/lib/release-job-rollout";
import { consumePrivateWorkerRehearsalAfterStaging } from "../src/lib/private-worker-rehearsal";
import {
  readAdmittedReceiptPage, closeReceiptAdmission, admitReceiptSource, acknowledgeReceiptPage,
  recordReceiptPageReported, receiptPageAdmitted, type ReceiptAdmissionState,
} from "../src/lib/job-attempt-receipts";
import type { Envelope } from "../src/lib/envelope";

describe.skipIf(!port)("production receipt ownership APIs on PostgreSQL", () => {
  let pool: Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  const rows = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
  beforeAll(async () => {
    pool = new Pool({ host: "127.0.0.1", port: Number(port), user: "postgres",
      database: process.env.POSTIL_RECEIPT_TEST_DATABASE, max: 8,
      connectionTimeoutMillis: 2000, statement_timeout: 6000, application_name: "receipt-api-fixture" });
    database = drizzle(pool, { schema });
    const [marker] = await rows(`SELECT shobj_description(oid,'pg_database') AS marker
      FROM pg_database WHERE datname=current_database()`);
    if (marker?.marker !== "disposable receipt qualification") throw new Error("dedicated fixture required");
    if (!repository) {
      const [installation] = await rows(`INSERT INTO installations(github_installation_id,account_login,account_type)
        VALUES($1,'receipt-test','Organization') RETURNING id`, [Date.now()]);
      const [repo] = await rows(`INSERT INTO repositories(installation_id,github_repo_id,full_name)
        VALUES($1,$2,'receipt-test/api') RETURNING id::text`, [installation.id, Date.now()]);
      repository = repo.id;
    }
  });
  afterAll(async () => { await pool?.end(); });
  async function start(payload: Record<string, unknown> = {}): Promise<ClaimedJob> {
    await rows("UPDATE jobs SET run_after='infinity' WHERE status='queued'");
    const [j] = await rows("INSERT INTO jobs(kind,payload,max_attempts) VALUES('review',$1,5) RETURNING id::text", [payload]);
    const c = await claimJob(pool, "reused-worker", ["review"]);
    expect(c?.receiptClaim?.jobId).toBe(j.id);
    expect(Object.isFrozen(c!.receiptClaim)).toBe(true);
    return c!;
  }
  const values = () => ({ repositoryId: Number(repository), prNumber: 1,
    headSha: randomBytes(20).toString("hex"), baseSha: randomBytes(20).toString("hex"), status: "running" as const });
  function envelope(): Envelope {
    return { version: 1, summary: randomUUID(), silent: true, findings: [], resolved: [],
      counts: { info: 0, warn: 0, error: 0, suppressed: 0, ungrounded: 0 },
      confidenceBuckets: [0, 0, 0, 0, 0], gate: { failOn: "error", failing: false },
      modelUsed: "fixture/model", usage: { promptTokens: 3, completionTokens: 2 }, durationMs: 1,
      baseSha: randomBytes(20).toString("hex"), headSha: randomBytes(20).toString("hex"), sinceSha: null };
  }
  function stageInput(c: ClaimedJob, reviewId: number, e = envelope()) {
    return { reviewId, reviewJobId: c.id, reviewClaim: c, envelope: e,
      configFiles: [], silent: true, gateFailing: false,
      publicationReceipt: { version: 1 as const, receiptId: randomUUID(), findings: [] } };
  }
  async function replace(c: ClaimedJob) {
    expect(await requeueJobsOwnedBy(pool, c.lockedBy, "fixture interruption", ["review"], [c.id], [c])).toBe(1);
    const next = await claimJob(pool, c.lockedBy, ["review"]);
    expect(next!.attempts).toBe(c.attempts);
    expect(next!.receiptClaim!.receiptId).not.toBe(c.receiptClaim!.receiptId);
    return next!;
  }
  const pointers = (c: ClaimedJob) => rows(`SELECT active_claim_receipt_id::text, staged_review_id::text,
    payload, status, attempts, locked_by, locked_at FROM jobs WHERE id=$1::bigint`, [c.receiptClaim!.jobId]);

  async function losingSpend(stageFirst = false) {
    const a = await start(); const review = (await insertReviewForClaim(database, values(), a))!;
    const [org] = await rows("INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id", ["Receipt fixture", randomUUID()]);
    const [reservation] = await rows(`INSERT INTO hosted_usage_reservations(org_id,review_id,reserved_micros,expires_at)
      VALUES($1,$2,1000,now()+interval '1 hour') RETURNING id`, [org.id, review.id]);
    const spend = { reservationId: reservation.id as string, repositoryId: Number(repository), reviewId: review.id,
      triggerSource: "unknown" as const, usageAccountingComplete: true,
      usage: [{ orgId: Number(org.id), repositoryId: Number(repository), promptTokens: 3, completionTokens: 2,
        modelUsed: "fixture/model", costMicros: 7, billingScope: "private_hosted" as const }] };
    const input = { ...stageInput(a, review.id), hostedSpend: spend };
    if (stageFirst) await stageReviewCompletionCandidate(database, input, null);
    const b = await replace(a);
    if (stageFirst) expect(await bindStagedReviewClaim(database, review.id, b)).toBe(true);
    else {
      const other = (await insertReviewForClaim(database, values(), b))!;
      await stageReviewCompletionCandidate(database, stageInput(b, other.id), null);
    }
    return { a, b, review, input, spend };
  }
  const spendState = async (reviewId: number) => (await rows(`SELECT r.status,r.actual_micros::text,
    (SELECT count(*)::int FROM usage_events u WHERE u.review_id=r.review_id) AS usage_count,
    (SELECT COALESCE(sum(cost_micros),0)::text FROM usage_events u WHERE u.review_id=r.review_id) AS cost
    FROM hosted_usage_reservations r WHERE r.review_id=$1`, [reviewId]))[0];

  test("losing stage settles its own receipt once and append failure rolls back the settlement", async () => {
    const { b, review, input } = await losingSpend(); const before = await pointers(b);
    await expect(stageReviewCompletionCandidate(database, { ...input,
      hostedSpend: { ...input.hostedSpend, repositoryId: Number(repository) + 1 } }, null)).rejects.toThrow("identity mismatch");
    await rows(`CREATE FUNCTION receipt_fixture_spend_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture append rejection'; END $$`);
    await rows(`CREATE TRIGGER receipt_fixture_spend_reject BEFORE INSERT ON job_attempt_receipts
      FOR EACH ROW EXECUTE FUNCTION receipt_fixture_spend_reject()`);
    try {
      await expect(stageReviewCompletionCandidate(database, input, null)).rejects.toThrow();
      expect(await spendState(review.id)).toEqual({ status: "active", actual_micros: null, usage_count: 0, cost: "0" });
      expect((await rows("SELECT envelope FROM reviews WHERE id=$1", [review.id]))[0].envelope).toBeNull();
      expect((await rows("SELECT count(*)::int AS n FROM review_publication_receipts WHERE review_id=$1", [review.id]))[0].n).toBe(0);
      expect(await pointers(b)).toEqual(before);
    } finally {
      await rows("DROP TRIGGER receipt_fixture_spend_reject ON job_attempt_receipts");
      await rows("DROP FUNCTION receipt_fixture_spend_reject()");
    }
    const results = await Promise.all([0, 1].map(() => stageReviewCompletionCandidate(database, input, null)));
    expect(results.every((r) => r.staged && r.claimOwned === false)).toBe(true);
    expect(await spendState(review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
    expect(await pointers(b)).toEqual(before);
    expect((await rows("SELECT count(*)::int AS n FROM job_attempt_receipts WHERE review_id=$1 AND outcome='staged'", [review.id]))[0].n).toBe(1);
    expect(await completeJob(pool, b)).toBe("done");
  });

  test("genuine recovery finalizes after the late producer already settles the same receipt", async () => {
    const { b, review, input, spend } = await losingSpend(true);
    expect((await stageReviewCompletionCandidate(database, input, null)).claimOwned).toBe(false);
    const accounting = { reviewId: review.id, reviewClaim: b, hostedUsageReservationId: spend.reservationId,
      usage: spend.usage, usageAccountingComplete: true };
    expect((await finalizeStagedReviewCompletionWithGateMode(database, accounting, null)).completed).toBe(true);
    expect((await finalizeStagedReviewCompletionWithGateMode(database, accounting, null)).completed).toBe(false);
    expect(await spendState(review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
    expect(await completeJob(pool, b)).toBe("done");
  });

  test("terminal staging settles once across current and lost claims without accepting stale evidence", async () => {
    for (const status of ["stale", "failed", "completed"]) {
      for (const recoveryOwns of [false, true]) {
        const x = await losingSpend(recoveryOwns);
        const input = recoveryOwns ? { ...x.input, reviewClaim: x.b } : x.input;
        await rows("UPDATE reviews SET status=$2,finished_at=now() WHERE id=$1", [x.review.id, status]);
        const before = await pointers(x.b);
        const evidence = await rows("SELECT envelope,gate_failing FROM reviews WHERE id=$1", [x.review.id]);
        const receipts = await rows("SELECT receipt_id::text FROM job_attempt_receipts WHERE review_id=$1 ORDER BY receipt_id", [x.review.id]);
        await expect(stageReviewCompletionCandidate(database, { ...input,
          hostedSpend: { ...x.spend, reviewId: x.review.id + 1 } }, null)).rejects.toThrow("identity mismatch");
        const results = await Promise.all([0, 1].map(() => stageReviewCompletionCandidate(database, input, null)));
        expect(results.every((r) => r.staged === false && r.completed === false)).toBe(true);
        expect(await spendState(x.review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
        expect(await pointers(x.b)).toEqual(before);
        expect((await rows("SELECT status FROM reviews WHERE id=$1", [x.review.id]))[0].status).toBe(status);
        expect(await rows("SELECT envelope,gate_failing FROM reviews WHERE id=$1", [x.review.id])).toEqual(evidence);
        expect(await rows("SELECT receipt_id::text FROM job_attempt_receipts WHERE review_id=$1 ORDER BY receipt_id", [x.review.id])).toEqual(receipts);
        expect(await completeJob(pool, x.b)).toBe("done");
      }
    }
  });

  test("terminal settlement rolls back on usage failure and backend death, then retries once", async () => {
    const x = await losingSpend();
    await rows("UPDATE reviews SET status='stale',finished_at=now() WHERE id=$1", [x.review.id]);
    const before = await pointers(x.b);
    await rows(`CREATE FUNCTION receipt_terminal_usage_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture usage rejection'; END $$`);
    await rows(`CREATE TRIGGER receipt_terminal_usage_reject BEFORE INSERT ON usage_events
      FOR EACH ROW EXECUTE FUNCTION receipt_terminal_usage_reject()`);
    try {
      await expect(stageReviewCompletionCandidate(database, x.input, null)).rejects.toThrow();
      expect(await spendState(x.review.id)).toEqual({ status: "active", actual_micros: null, usage_count: 0, cost: "0" });
      expect(await pointers(x.b)).toEqual(before);
    } finally {
      await rows("DROP TRIGGER receipt_terminal_usage_reject ON usage_events");
      await rows("DROP FUNCTION receipt_terminal_usage_reject()");
    }
    const blocker = await pool.connect();
    const producer = new Pool({ host: "127.0.0.1", port: Number(port), user: "postgres",
      database: process.env.POSTIL_RECEIPT_TEST_DATABASE, max: 1, statement_timeout: 4000 });
    let inserting!: () => void;
    const reached = new Promise<void>((resolve) => { inserting = resolve; });
    producer.on("connect", (client) => {
      client.on("error", () => undefined);
      const original = client.query.bind(client);
      client.query = ((...args: any[]) => {
        if ((typeof args[0] === "string" ? args[0] : args[0]?.text)?.startsWith('insert into "usage_events"')) inserting();
        return (original as Function)(...args);
      }) as typeof client.query;
    });
    try {
      const pid = (await producer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("BEGIN"); await blocker.query("LOCK TABLE usage_events IN ACCESS EXCLUSIVE MODE");
      const pending = stageReviewCompletionCandidate(drizzle(producer, { schema }), x.input, null).then(() => false, () => true);
      await reached;
      expect((await rows("SELECT status,actual_micros FROM hosted_usage_reservations WHERE review_id=$1", [x.review.id]))[0])
        .toEqual({ status: "active", actual_micros: null });
      await rows("SELECT pg_terminate_backend($1,1000)", [pid]);
      expect(await pending).toBe(true);
      await blocker.query("COMMIT");
      expect(await spendState(x.review.id)).toEqual({ status: "active", actual_micros: null, usage_count: 0, cost: "0" });
      expect(await pointers(x.b)).toEqual(before);
      expect((await stageReviewCompletionCandidate(database, x.input, null)).staged).toBe(false);
      expect((await stageReviewCompletionCandidate(database, x.input, null)).staged).toBe(false);
      expect(await spendState(x.review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await producer.end(); }
  });

  test("B wins staging: concurrent stale A retains only A evidence and cannot mutate B", async () => {
    const a = await start(); const ra = (await insertReviewForClaim(database, values(), a))!;
    const b = await replace(a); const rb = (await insertReviewForClaim(database, values(), b))!;
    expect((await stageReviewCompletionCandidate(database, stageInput(b, rb.id), null)).claimOwned).toBe(true);
    const before = await pointers(b);
    const results = await Promise.all([
      stageReviewCompletionCandidate(database, stageInput(a, ra.id), null),
      completeJob(pool, a), failJob(pool, a, "stale", { permanent: true }),
      retryJobIndefinitely(pool, a, "stale"),
      continueClaimedJob(pool, a, {}).then(() => false, () => true),
      requeueJobsOwnedBy(pool, a.lockedBy, "stale", ["review"], [a.id], [a]),
    ]);
    expect(results[0]).toMatchObject({ staged: true, claimOwned: false });
    expect(results.slice(1)).toEqual(["lost", "lost", "lost", true, 0]);
    expect(await pointers(b)).toEqual(before);
    expect(await consumePrivateWorkerRehearsalAfterStaging(pool, {
      reviewId: ra.id, reviewJobId: a.id, reviewClaim: a,
      repoFullName: "fixture/rehearsal", prNumber: 1, headSha: randomBytes(20).toString("hex"),
      workerInstanceId: "reused-worker", sandbox: { orgSlug: "fixture", repoFullName: "fixture/rehearsal" },
    })).toBeNull();
    expect(await pointers(b)).toEqual(before);
    expect((await rows(`SELECT claim_receipt_id::text FROM job_attempt_receipts
      WHERE review_id=$1 AND event_kind='review_observed'`, [ra.id]))).toEqual([{ claim_receipt_id: a.receiptClaim!.receiptId }]);
    expect(await externalSideEffectLeaseActive(pool, a)).toBe(false);
    expect(await externalSideEffectLeaseActive(pool, b)).toBe(true);
    expect(await completeJob(pool, b)).toBe("done");
    expect(await completeJob(pool, b)).toBe("lost");
  });

  test("A stages first: B binds the genuine target and accounts once with real reservation effects", async () => {
    const a = await start(); const r = (await insertReviewForClaim(database, values(), a))!;
    const e = envelope();
    e.modelIncidents = [0, 1].map(() => ({ phase: "review", category: "timeout", recovered: true, recovery: "repair" }));
    const input = stageInput(a, r.id, e);
    expect((await stageReviewCompletionCandidate(database, input, null)).claimOwned).toBe(true);
    expect((await stageReviewCompletionCandidate(database, input, null)).staged).toBe(true);
    expect((await rows("SELECT count(*)::int AS n FROM job_attempt_receipts WHERE review_id=$1 AND event_kind='incident'", [r.id]))[0].n).toBe(2);
    const b = await replace(a);
    expect(await bindStagedReviewClaim(database, r.id, b)).toBe(true);
    expect(await bindStagedReviewClaim(database, r.id, b)).toBe(true);
    const [org] = await rows("INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id", ["Receipt fixture", randomUUID()]);
    const [reservation] = await rows(`INSERT INTO hosted_usage_reservations(org_id,review_id,reserved_micros,expires_at)
      VALUES($1,$2,1000,now()+interval '1 hour') RETURNING id`, [org.id, r.id]);
    const completion = { reviewId: r.id, reviewClaim: b, hostedUsageReservationId: reservation.id,
      usageAccountingComplete: true, usage: [{ orgId: Number(org.id), repositoryId: Number(repository),
        promptTokens: 3, completionTokens: 2, modelUsed: "fixture/model", costMicros: 7, billingScope: "private_hosted" as const }] };
    expect((await finalizeStagedReviewCompletionWithGateMode(database, completion, null)).completed).toBe(true);
    expect((await finalizeStagedReviewCompletionWithGateMode(database, completion, null)).completed).toBe(false);
    expect((await rows("SELECT status,actual_micros::text FROM hosted_usage_reservations WHERE id=$1", [reservation.id]))[0])
      .toEqual({ status: "reconciled", actual_micros: "7" });
    expect((await rows("SELECT count(*)::int AS n FROM usage_events WHERE review_id=$1", [r.id]))[0].n).toBe(1);
    expect((await rows("SELECT origin_claim_receipt_id::text FROM reviews WHERE id=$1", [r.id]))[0].origin_claim_receipt_id).toBe(a.receiptClaim!.receiptId);
    expect(await completeJob(pool, b)).toBe("done");
  });

  test("raw decimal job identity survives numeric compatibility and origin cannot be reassigned", async () => {
    await rows("UPDATE jobs SET run_after='infinity' WHERE status='queued'");
    const raw = (9007199254740993n + BigInt(randomBytes(4).readUInt32BE()) * 2n).toString();
    await rows("INSERT INTO jobs(id,kind,payload) OVERRIDING SYSTEM VALUE VALUES($1,'review','{}')", [raw]);
    const a = (await claimJob(pool, "raw-fixture", ["review"]))!;
    expect(a.receiptClaim!.jobId).toBe(raw);
    const review = (await insertReviewForClaim(database, values(), a))!;
    await expect(rows("UPDATE reviews SET origin_claim_receipt_id=NULL WHERE id=$1", [review.id])).rejects.toThrow("immutable review origin");
    expect((await stageReviewCompletionCandidate(database, stageInput(a, review.id), null)).claimOwned).toBe(true);
    expect(await completeJob(pool, a)).toBe("done");
    expect((await rows("SELECT job_id::text FROM job_attempt_receipts WHERE claim_receipt_id=$1 AND event_kind='queue_closed'", [a.receiptClaim!.receiptId]))[0].job_id).toBe(raw);
  });

  test("same-job history and a forged payload cannot authorize a new binding", async () => {
    const a = await start(); const r = (await insertReviewForClaim(database, values(), a))!;
    const b = await replace(a);
    await rows("UPDATE jobs SET payload=jsonb_build_object('recoveryReviewId',$2::bigint) WHERE id=$1", [b.id, r.id]);
    expect(await bindStagedReviewClaim(database, r.id, b)).toBe(false);
    await expect(stageReviewCompletionCandidate(database, stageInput(b, r.id), null)).rejects.toThrow("binding is missing");
    const altered = { ...b, lockedAt: new Date(b.lockedAt.getTime() + 1) };
    expect(await completeJob(pool, altered)).toBe("lost");
    expect(await externalSideEffectLeaseActive(pool, altered)).toBe(false);
    expect(await completeJob(pool, b)).toBe("done");
  });

  test("legacy-origin recovery remains available but still honors the new owner's lease", async () => {
    const c = await start();
    const r = (await insertReviewForClaim(database, values()))!;
    const input = stageInput(c, r.id);
    await stageReviewCompletionCandidate(database, { ...input, reviewClaim: undefined }, null);
    const accounting = { reviewId: r.id, reviewClaim: c, usageAccountingComplete: true,
      usage: [{ orgId: null, repositoryId: Number(repository), promptTokens: 0, completionTokens: 0,
        modelUsed: "fixture/model", costMicros: 0, billingScope: "analytics" as const }] };
    expect((await finalizeStagedReviewCompletionWithGateMode(database, { ...accounting,
      reviewClaim: { ...c, lockedAt: new Date(c.lockedAt.getTime() + 1) } }, null)).completed).toBe(false);
    expect((await finalizeStagedReviewCompletionWithGateMode(database, accounting, null)).completed).toBe(true);
    expect((await rows("SELECT origin_claim_receipt_id FROM reviews WHERE id=$1", [r.id]))[0].origin_claim_receipt_id).toBeNull();
    expect((await rows("SELECT count(*)::int AS n FROM job_attempt_receipts WHERE review_id=$1", [r.id]))[0].n).toBe(0);
    expect(await completeJob(pool, c)).toBe("done");
  });

  test("append rejection rolls back claim, staging, publication and queue effects", async () => {
    const a = await start(); const r = (await insertReviewForClaim(database, values(), a))!;
    const before = await pointers(a);
    await rows(`CREATE FUNCTION receipt_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture append rejection'; END $$`);
    await rows(`CREATE TRIGGER receipt_fixture_reject BEFORE INSERT ON job_attempt_receipts
      FOR EACH ROW EXECUTE FUNCTION receipt_fixture_reject()`);
    try {
      await expect(stageReviewCompletionCandidate(database, stageInput(a, r.id), null)).rejects.toThrow();
      expect(await pointers(a)).toEqual(before);
      expect((await rows("SELECT envelope FROM reviews WHERE id=$1", [r.id]))[0].envelope).toBeNull();
      await expect(completeJob(pool, a)).rejects.toThrow();
      expect(await pointers(a)).toEqual(before);
      await rows("INSERT INTO jobs(kind,payload) VALUES('review','{}')");
      await expect(claimJob(pool, "failure", ["review"])).rejects.toThrow();
      expect((await rows("SELECT count(*)::int AS n FROM jobs WHERE locked_by='failure'"))[0].n).toBe(0);
    } finally {
      await rows("DROP TRIGGER receipt_fixture_reject ON job_attempt_receipts");
      await rows("DROP FUNCTION receipt_fixture_reject()");
    }
    expect(await completeJob(pool, a)).toBe("done");
  });

  test("staging holds the job fence while blocked at append; backend death rolls back a claim", async () => {
    const a = await start(); const r = (await insertReviewForClaim(database, values(), a))!;
    const blocker = await pool.connect();
    await blocker.query("BEGIN"); await blocker.query(receiptAppendLockSql);
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const producer = new Pool({ host: "127.0.0.1", port: Number(port), user: "postgres",
      database: process.env.POSTIL_RECEIPT_TEST_DATABASE, max: 1, statement_timeout: 4000 });
    producer.on("connect", (client) => {
      client.on("error", () => undefined);
      const original = client.query.bind(client);
      client.query = ((...args: any[]) => {
        if ((typeof args[0] === "string" ? args[0] : args[0]?.text)?.includes("pg_advisory_xact_lock(17491")) reached();
        return (original as Function)(...args);
      }) as typeof client.query;
    });
    try {
      const staged = stageReviewCompletionCandidate(drizzle(producer, { schema }), stageInput(a, r.id), null);
      await waiting;
      const contender = await pool.connect();
      await contender.query("BEGIN"); await contender.query("SET LOCAL lock_timeout='100ms'");
      await expect(contender.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE", [a.id])).rejects.toMatchObject({ code: "55P03" });
      await contender.query("ROLLBACK"); contender.release();
      await blocker.query("COMMIT");
      expect((await staged).claimOwned).toBe(true);
      const b = await replace(a);
      expect(await bindStagedReviewClaim(database, r.id, b)).toBe(true);
      expect(await completeJob(pool, b)).toBe("done");
      await rows("UPDATE jobs SET run_after='infinity' WHERE status='queued'");
      const [j] = await rows("INSERT INTO jobs(kind,payload) VALUES('review','{}') RETURNING id::text");
      await blocker.query("BEGIN"); await blocker.query(receiptAppendLockSql);
      const dying = await producer.connect();
      const pid = (await dying.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      dying.release();
      const reachedAgain = new Promise<void>((resolve) => { reached = resolve; });
      const pending = claimJob(producer, "crash-fixture", ["review"]);
      const failure = pending.then(() => false, () => true);
      await reachedAgain;
      await rows("SELECT pg_terminate_backend($1)", [pid]);
      expect(await failure).toBe(true);
      await blocker.query("COMMIT");
      expect((await rows("SELECT status,attempts,active_claim_receipt_id FROM jobs WHERE id=$1", [j.id]))[0])
        .toEqual({ status: "queued", attempts: 0, active_claim_receipt_id: null });
      await rows("UPDATE jobs SET run_after=now() WHERE id=$1", [j.id]);
      const retry = (await claimJob(pool, "crash-fixture", ["review"]))!;
      expect(retry.receiptClaim!.jobId).toBe(j.id);
      expect(await completeJob(pool, retry)).toBe("done");
      const lost = await losingSpend(); const before = await pointers(lost.b);
      const stageBackend = (await producer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("BEGIN"); await blocker.query(receiptAppendLockSql);
      const settlementReached = new Promise<void>((resolve) => { reached = resolve; });
      const pendingStage = stageReviewCompletionCandidate(drizzle(producer, { schema }), lost.input, null);
      const failedStage = pendingStage.then(() => false, () => true);
      await settlementReached;
      expect(await spendState(lost.review.id)).toEqual({ status: "active", actual_micros: null, usage_count: 0, cost: "0" });
      await rows("SELECT pg_terminate_backend($1,1000)", [stageBackend]);
      expect(await failedStage).toBe(true); await blocker.query("COMMIT");
      expect(await spendState(lost.review.id)).toEqual({ status: "active", actual_micros: null, usage_count: 0, cost: "0" });
      expect(await pointers(lost.b)).toEqual(before);
      expect((await stageReviewCompletionCandidate(database, lost.input, null)).claimOwned).toBe(false);
      expect(await spendState(lost.review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await producer.end(); }
  });

  test("wire-lost COMMIT is reconciled from one durable claim rather than replayed", async () => {
    await rows("UPDATE jobs SET run_after='infinity' WHERE status='queued'");
    const [j] = await rows("INSERT INTO jobs(kind,payload) VALUES('review','{}') RETURNING id::text");
    let dropped = 0;
    const sockets = new Set<ReturnType<typeof connectSocket>>();
    const proxy = createServer((front) => {
      const back = connectSocket({ host: "127.0.0.1", port: Number(port) });
      sockets.add(front); sockets.add(back);
      front.on("data", (bytes) => back.write(bytes));
      front.on("error", () => back.destroy()); back.on("error", () => front.destroy());
      front.on("close", () => { sockets.delete(front); back.destroy(); });
      back.on("close", () => { sockets.delete(back); front.destroy(); });
      let buffered = Buffer.alloc(0);
      back.on("data", (bytes) => {
        buffered = Buffer.concat([buffered, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
        while (buffered.length >= 5) {
          const size = buffered.readUInt32BE(1) + 1;
          if (buffered.length < size) break;
          const frame = buffered.subarray(0, size); buffered = buffered.subarray(size);
          if (frame[0] === 67 && frame.subarray(5).toString() === "COMMIT\0") {
            dropped++; front.destroy(); back.destroy(); return;
          }
          front.write(frame);
        }
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("fixture proxy unavailable");
    const wire = new Pool({ host: "127.0.0.1", port: address.port, user: "postgres",
      database: process.env.POSTIL_RECEIPT_TEST_DATABASE, connectionTimeoutMillis: 2000 });
    wire.on("connect", (client) => client.on("error", () => undefined));
    try {
      await expect(claimJob(wire, "wire-fixture", ["review"])).rejects.toThrow();
      expect(dropped).toBe(1);
      const [persisted] = await rows("SELECT status,attempts,active_claim_receipt_id::text FROM jobs WHERE id=$1", [j.id]);
      expect(persisted.status).toBe("running"); expect(persisted.attempts).toBe(1);
      expect((await rows("SELECT count(*)::int AS n FROM job_attempt_receipts WHERE job_id=$1 AND event_kind='claim'", [j.id]))[0].n).toBe(1);
      expect(persisted.active_claim_receipt_id).not.toBeNull();
      // No retry is performed after the unknown wire result.
      const lost = await losingSpend(); const before = await pointers(lost.b);
      await expect(stageReviewCompletionCandidate(drizzle(wire, { schema }), lost.input, null)).rejects.toThrow();
      expect(dropped).toBe(2);
      expect(await spendState(lost.review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
      expect(await pointers(lost.b)).toEqual(before);
      expect((await stageReviewCompletionCandidate(database, lost.input, null)).claimOwned).toBe(false);
      expect(await spendState(lost.review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
      const terminal = await losingSpend(); const terminalBefore = await pointers(terminal.b);
      await rows("UPDATE reviews SET status='stale',finished_at=now() WHERE id=$1", [terminal.review.id]);
      await expect(stageReviewCompletionCandidate(drizzle(wire, { schema }), terminal.input, null)).rejects.toThrow();
      expect(dropped).toBe(3);
      expect(await spendState(terminal.review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
      expect((await stageReviewCompletionCandidate(database, terminal.input, null)).staged).toBe(false);
      expect(await spendState(terminal.review.id)).toEqual({ status: "reconciled", actual_micros: "7", usage_count: 1, cost: "7" });
      expect(await pointers(terminal.b)).toEqual(terminalBefore);
    } finally {
      await wire.end(); for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  test("legacy callers stay available; typed cancellation and deferral close the actual claim", async () => {
    const a = await start({ installationId: 101, sourceInstallationId: 102, sourceOrgId: 103,
      githubRepoId: 104, repoFullName: "fixture/repository", prNumber: 1 });
    expect(await cancelPullRequestPublication(pool, { installationId: 101, sourceInstallationId: 102,
      sourceOrgId: 103, githubRepoId: 104, repoFullName: "fixture/repository", prNumber: 1 })).toBe(1);
    expect(await completeJob(pool, a)).toBe("lost");
    expect((await rows("SELECT outcome FROM job_attempt_receipts WHERE claim_receipt_id=$1 AND event_kind='queue_closed'", [a.receiptClaim!.receiptId]))[0].outcome).toBe("cancelled");
    const b = await start();
    await deferHostedReviewForRelease(pool, b, randomBytes(20).toString("hex"));
    expect((await rows("SELECT outcome FROM job_attempt_receipts WHERE claim_receipt_id=$1 AND event_kind='queue_closed'", [b.receiptClaim!.receiptId]))[0].outcome).toBe("deferred");
    const c = await start();
    const legacy = { id: c.id, lockedBy: c.lockedBy };
    expect(await completeJob(pool, legacy)).toBe("done");
    // The old writer remains callable, and does not manufacture a qualified closure.
    expect((await rows("SELECT count(*)::int AS n FROM job_attempt_receipts WHERE claim_receipt_id=$1 AND event_kind='queue_closed'", [c.receiptClaim!.receiptId]))[0].n).toBe(0);
  });

  test("generated actual queue transitions retain one closure per claim across ordinal reuse", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      let current = await start();
      for (let step = 0; step < 4; step++) {
        const operation = (seed * 17 + step * 13) % 4;
        const id = current.receiptClaim!.receiptId;
        let expected: string;
        if (operation === 0) { await continueClaimedJob(pool, current, { fixture: randomUUID() }); expected = "continued"; }
        else if (operation === 1) { expect(await retryJobIndefinitely(pool, current, randomBytes(12).toString("base64"))).toBe("retried"); expected = "retry"; }
        else if (operation === 2) { expect(await failJob(pool, current, "fixture retry")).toBe("retried"); expected = "retry"; }
        else { expect(await requeueJobsOwnedBy(pool, current.lockedBy, "fixture interruption", ["review"], [current.id], [current])).toBe(1); expected = "interrupted"; }
        expect(await completeJob(pool, current)).toBe("lost");
        expect(await rows("SELECT outcome FROM job_attempt_receipts WHERE claim_receipt_id=$1 AND event_kind='queue_closed'", [id])).toEqual([{ outcome: expected }]);
        await rows("UPDATE jobs SET run_after=now() WHERE id=$1::bigint", [current.receiptClaim!.jobId]);
        const next = (await claimJob(pool, current.lockedBy, ["review"]))!;
        expect(next.receiptClaim!.receiptId).not.toBe(id);
        current = next;
      }
      expect(await completeJob(pool, current)).toBe("done");
    }
  });

  test("existing unavailable-review path atomically binds its finite failure observation", async () => {
    const a = await start();
    const r = await claimPausedHostedReview(database, { ...values(), authorGithubId: null, authorLogin: null,
      sinceSha: null, triggerSource: "unknown", triggerContext: { source: "unknown" }, queuedAt: new Date(), startedAt: new Date() },
    { installationId: 1, repoFullName: "fixture/repository", reviewClaim: a });
    expect(r).not.toBeNull();
    expect((await rows("SELECT event_kind,outcome FROM job_attempt_receipts WHERE review_id=$1 ORDER BY receipt_id", [r!.id]))
      .map((r) => [r.event_kind, r.outcome])).toEqual([["review_bound", "bound"], ["review_observed", "failed"]]);
    expect(await completeJob(pool, a)).toBe("done");
  });

  test("actual reader admission rejects a different target and stale ACK across a cut", async () => {
    const [genesis] = await rows("SELECT source_epoch::text FROM job_attempt_receipts WHERE receipt_id=0");
    let state: ReceiptAdmissionState = { revision: 1, binding: { target: randomUUID(), epoch: genesis.source_epoch, schema: 1 }, prefix: "0" };
    const target = state.binding!.target;
    const read = () => readAdmittedReceiptPage(state, async (text, values) => ({ target, rows: await rows(text, values) }));
    const proposal = await read();
    expect(proposal.status).toBe("READY");
    if (proposal.status !== "READY") throw new Error("fixture page unavailable");
    expect(acknowledgeReceiptPage(state, proposal.page, "9223372036854775807")).toBeNull();
    expect(acknowledgeReceiptPage(state, proposal.page, proposal.page.through)).toBeNull();
    const reported = recordReceiptPageReported(state, proposal.page, proposal.page.rows[0]!.receipt_id as string)!;
    const accepted = acknowledgeReceiptPage(reported, proposal.page, reported.reportedThrough!)!;
    expect(accepted.prefix).not.toBe("0");
    state = closeReceiptAdmission(accepted);
    expect(state.prefix).toBe(accepted.prefix);
    expect(acknowledgeReceiptPage(state, proposal.page, proposal.page.through)).toBeNull();
    expect(admitReceiptSource(state, proposal.page.binding, state.revision, "0")).toBeNull();
    const distinct = { ...proposal.page.binding, target: randomUUID() };
    state = admitReceiptSource(state, distinct, state.revision, "0")!;
    expect((await read()).status).toBe("UNKNOWN");
    const admitted = await readAdmittedReceiptPage(state, async (text, values) => ({ target: distinct.target, rows: await rows(text, values) }));
    expect(admitted.status).toBe("READY");

  });
  test("generated admission/read/delivery/ACK histories never cross a binding or ACK an unreported row", async () => {
    const [control] = await rows("SELECT source_epoch::text FROM job_attempt_receipts WHERE receipt_id=0");
    for (let seed = 1; seed <= 16; seed++) {
      let random = seed;
      const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
      let state: ReceiptAdmissionState = { revision: 1, binding: { target: randomUUID(), epoch: control.source_epoch, schema: 1 }, prefix: "0" };
      const pages: Array<Extract<Awaited<ReturnType<typeof readAdmittedReceiptPage>>, { status: "READY" }>["page"]> = [];
      const delivered = new Map<string, string>();
      for (let step = 0; step < 24; step++) {
        const action = next() % 5;
        if (action === 0 && state.binding) {
          const target = state.binding.target;
          const page = await readAdmittedReceiptPage(state, async (text, values) => ({ target, rows: await rows(text, values) }));
          expect(page.status).toBe("READY");
          if (page.status === "READY") pages.push(page.page);
        } else if (action === 1 && pages.length) {
          const page = pages[next() % pages.length]!;
          const report = recordReceiptPageReported(state, page, page.through);
          if (report) {
            expect(receiptPageAdmitted(state, page)).toBe(true);
            delivered.set(`${page.binding.target}:${page.revision}:${page.after}`, page.through);
            state = report;
          }
        } else if (action === 2 && pages.length) {
          const page = pages[next() % pages.length]!;
          const acknowledged = acknowledgeReceiptPage(state, page, page.through);
          if (acknowledged) {
            expect(delivered.get(`${page.binding.target}:${page.revision}:${page.after}`)).toBe(page.through);
            expect(acknowledged.binding).toEqual(state.binding);
            expect(BigInt(acknowledged.prefix) >= BigInt(state.prefix)).toBe(true);
            state = acknowledged;
          }
        } else if (action === 3) {
          const prefix = state.prefix;
          state = closeReceiptAdmission(state);
          expect(state.prefix).toBe(prefix);
          for (const page of pages) expect(acknowledgeReceiptPage(state, page, page.through)).toBeNull();
        } else if (!state.binding) {
          const binding = { target: randomUUID(), epoch: control.source_epoch, schema: 1 };
          const revision = state.revision;
          state = admitReceiptSource(state, binding, revision, "0")!;
          expect(admitReceiptSource(state, binding, revision, "0")).toEqual(state);
        }
      }
    }
  });

});
