import { sql, type SQL } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";

/** SQL transaction tails for explicitly bound review claims. */
export interface ReceiptClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PreparedReceipt {
  jobId: string;
  ordinal: number;
  jobKind: "review" | "review-feedback";
  claimId: string | null;
  reviewId: string | null;
  reviewPublicId: string | null;
  eventKind: "claim" | "review_bound" | "review_observed" | "incident" | "queue_closed";
  outcome: "started" | "bound" | "staged" | "completed" | "failed" | "observed"
    | "succeeded" | "retry" | "continued" | "interrupted" | "cancelled" | "coalesced" | "deferred";
  phase: "planner" | "review" | "scorer" | "respond" | null;
  category: "providerError" | "invalidOutput" | "timeout" | "deadline" | null;
  recovered: boolean | null;
  recovery: "repair" | "fallback" | null;
}

export const receiptAppendLockSql = "SELECT pg_advisory_xact_lock(17491, 1)";
export const receiptHeadSql =
  "SELECT r.receipt_id::text FROM job_attempt_receipts r ORDER BY r.receipt_id DESC LIMIT 1";

const receiptInsertSql = `
WITH allocated AS (
  SELECT nextval('job_attempt_receipt_ids') AS id
)
INSERT INTO job_attempt_receipts (
  receipt_id, predecessor_id, claim_receipt_id, job_id, ordinal, job_kind,
  review_id, review_public_id, event_kind, outcome, phase, category, recovered,
  recovery, binding_receipt_id
)
SELECT id, $1::bigint, COALESCE($2::bigint, id), $3::bigint, $4::integer, $5,
       $6::bigint, $7::uuid, $8, $9, $10, $11, $12::boolean, $13,
       CASE WHEN $8 IN ('review_observed', 'incident') THEN (
         SELECT receipt_id FROM job_attempt_receipts
         WHERE claim_receipt_id = $2::bigint AND review_id = $6::bigint
           AND event_kind = 'review_bound'
       ) END
FROM allocated
RETURNING receipt_id::text`;

/**
 * The caller owns a READ COMMITTED transaction and all business locks. Prepare
 * and validate business state before calling; COMMIT immediately after return,
 * except for assigning a new claim ID to its already locked job row. On error
 * ROLLBACK the entire transaction. An uncertain COMMIT requires reconciliation.
 */
export async function appendPreparedReceiptBatch(
  client: ReceiptClient,
  events: readonly PreparedReceipt[],
): Promise<string[]> {
  const prepared = events.map((event) => {
    // Reject accessors before reading any value. Only primitive domain fields
    // enter the SQL arguments; an exception message or envelope is never read.
    const fields = ["jobId", "ordinal", "jobKind", "claimId", "reviewId",
      "reviewPublicId", "eventKind", "outcome", "phase", "category",
      "recovered", "recovery"] as const;
    const descriptors = Object.getOwnPropertyDescriptors(event);
    if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(
      (field) => !descriptors[field] || !("value" in descriptors[field]!),
    )) throw new Error("invalid receipt projection");
    const value = Object.fromEntries(fields.map((field) => [field, descriptors[field]!.value]));
    for (const field of fields) {
      if (value[field] !== null && !["string", "number", "boolean"].includes(typeof value[field])) {
        throw new Error("invalid receipt projection");
      }
    }
    for (const field of ["jobId", "claimId", "reviewId"]) {
      if (value[field] !== null && (typeof value[field] !== "string" || !/^[1-9][0-9]{0,18}$/.test(value[field]))) {
        throw new Error("invalid receipt identity");
      }
    }
    if (value.jobId === null || typeof value.ordinal !== "number" || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1) {
      throw new Error("invalid receipt identity");
    }
    return fields.map((field) => value[field]);
  });
  if (prepared.length === 0) return [];
  const isolation = await client.query("SHOW transaction_isolation");
  if (isolation.rows[0]?.transaction_isolation !== "read committed") {
    throw new Error("receipt transaction requires read committed");
  }
  // Separate statements are intentional: the predecessor snapshot is acquired
  // after the append lock wait, never in the statement that waits for it.
  await client.query(receiptAppendLockSql);
  let predecessor = (await client.query(receiptHeadSql)).rows[0]?.receipt_id;
  if (typeof predecessor !== "string") throw new Error("receipt genesis unavailable");
  const ids: string[] = [];
  for (const fields of prepared) {
    const [job, ordinal, kind, claim, review, publicId, event, outcome, phase, category, recovered, recovery] = fields;
    const result = await client.query(receiptInsertSql, [predecessor, claim, job, ordinal,
      kind, review, publicId, event, outcome, phase, category, recovered, recovery]);
    const id = result.rows[0]?.receipt_id;
    if (typeof id !== "string") throw new Error("receipt append unavailable");
    ids.push(id);
    predecessor = id;
  }
  return ids;
}

/** Execute while holding the job and review locks, before the append tail. */
export const stageOwnedReviewSql = `
UPDATE jobs j
SET staged_review_id = r.id,
    payload = j.payload || jsonb_build_object('recoveryReviewId', r.id)
FROM reviews r
WHERE j.id = $1::bigint AND j.status = 'running'
  AND j.active_claim_receipt_id = $2::bigint AND j.locked_by = $3
  AND r.id = $4::bigint AND r.status = 'running'
  AND EXISTS (
    SELECT 1 FROM job_attempt_receipts b
    WHERE b.event_kind = 'review_bound' AND b.job_id = j.id
      AND b.claim_receipt_id = j.active_claim_receipt_id
      AND b.review_id = r.id AND b.review_public_id = r.public_id
  )
RETURNING j.id::text`;

/** One snapshot, scalar projection, finite page; no ACK or application pool. */
export const readAttemptReceiptPageSql = `
WITH genesis AS MATERIALIZED (
  SELECT source_epoch, schema_version FROM job_attempt_receipts WHERE receipt_id = 0
), anchor AS MATERIALIZED (
  SELECT receipt_id FROM job_attempt_receipts WHERE receipt_id = $1::bigint
), head AS MATERIALIZED (
  SELECT receipt_id FROM job_attempt_receipts ORDER BY receipt_id DESC LIMIT 1
)
SELECT g.source_epoch::text, g.schema_version,
       a.receipt_id::text AS anchor_id, h.receipt_id::text AS head_id,
       p.receipt_id::text, p.predecessor_id::text, p.claim_receipt_id::text,
       p.job_id::text, p.ordinal, p.job_kind, p.review_id::text,
       p.review_public_id::text, p.event_kind, p.outcome, p.phase, p.category,
       p.recovered, p.recovery,
       to_char(p.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
FROM (SELECT 1) control
LEFT JOIN genesis g ON true LEFT JOIN anchor a ON true LEFT JOIN head h ON true
LEFT JOIN LATERAL (
  SELECT receipt_id, predecessor_id, claim_receipt_id, job_id, ordinal,
         job_kind, review_id, review_public_id, event_kind, outcome, phase,
         category, recovered, recovery, occurred_at
  FROM job_attempt_receipts WHERE receipt_id > $1::bigint
  ORDER BY receipt_id LIMIT 64
) p ON true
ORDER BY p.receipt_id`;


/** The expected identity is captured at claim commit, never refreshed on completion. */
export interface ReceiptClaim {
  readonly jobId: string;
  readonly receiptId: string;
}
export interface ReviewClaimLease {
  id: number;
  lockedBy: string;
  lockedAt: Date;
  receiptClaim?: ReceiptClaim;
}

/** Bind trusted domain statements to the caller's supported Drizzle executor. */
export function transactionReceiptClient(tx: {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}): ReceiptClient {
  return {
    async query(text, values = []) {
      const parts = text.split(/\$(\d+)/g).map((part, index) => index % 2
        ? sql`${values[Number(part) - 1]}` : sql.raw(part));
      return tx.execute(sql.join(parts, sql``));
    },
  };
}

export async function lockReceiptClaim(client: ReceiptClient, lease: ReviewClaimLease) {
  const claim = lease.receiptClaim;
  if (!claim) return null;
  const result = await client.query(`SELECT j.id::text, j.kind, j.attempts,
      j.active_claim_receipt_id::text, j.staged_review_id::text,
      (j.status = 'running' AND j.active_claim_receipt_id = $2::bigint
        AND j.locked_by = $3 AND j.locked_at = $4::timestamptz) AS owned
    FROM jobs j WHERE j.id = $1::bigint FOR UPDATE`,
  [claim.jobId, claim.receiptId, lease.lockedBy, lease.lockedAt]);
  return result.rows[0] ?? null;
}

export function claimEvent(jobId: string, ordinal: number, claimId: string | null,
  eventKind: PreparedReceipt["eventKind"], outcome: PreparedReceipt["outcome"],
  reviewId: string | null = null, reviewPublicId: string | null = null): PreparedReceipt {
  return { jobId, ordinal, jobKind: "review", claimId, reviewId, reviewPublicId,
    eventKind, outcome, phase: null, category: null, recovered: null, recovery: null };
}

/** All business mutations in body precede this transaction's single append tail. */
export async function transitionReceiptClaim<T extends string>(
  pool: Pool, lease: ReviewClaimLease, body: (client: PoolClient) => Promise<T>,
  outcome: (result: T) => PreparedReceipt["outcome"],
): Promise<T | "lost"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockReceiptClaim(client, lease);
    if (!row?.owned) { await client.query("ROLLBACK"); return "lost"; }
    const result = await body(client);
    if (result !== "lost") {
      await client.query("UPDATE jobs SET active_claim_receipt_id = NULL WHERE id = $1::bigint",
        [lease.receiptClaim!.jobId]);
      await appendPreparedReceiptBatch(client, [claimEvent(lease.receiptClaim!.jobId,
        Number(row.attempts), lease.receiptClaim!.receiptId, "queue_closed", outcome(result))]);
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Prepare terminal observations before the append lock; legacy rows stay unqualified. */
export async function prepareReviewObservation(client: ReceiptClient, reviewId: number,
  outcome: PreparedReceipt["outcome"], lease?: ReviewClaimLease): Promise<PreparedReceipt[]> {
  const result = await client.query(`SELECT b.claim_receipt_id::text, b.job_id::text,
      b.ordinal, b.review_id::text, b.review_public_id::text
    FROM job_attempt_receipts b JOIN reviews r ON r.id = b.review_id
    WHERE b.event_kind = 'review_bound' AND r.id = $1::bigint
      AND b.claim_receipt_id = COALESCE($2::bigint, r.origin_claim_receipt_id)
      AND b.review_public_id = r.public_id
      AND NOT EXISTS (SELECT 1 FROM job_attempt_receipts o
        WHERE o.event_kind = 'review_observed' AND o.claim_receipt_id = b.claim_receipt_id
          AND o.review_id = r.id AND o.outcome = $3)`,
  [String(reviewId), lease?.receiptClaim?.receiptId ?? null, outcome]);
  return result.rows.map((r) => claimEvent(String(r.job_id), Number(r.ordinal),
    String(r.claim_receipt_id), "review_observed", outcome, String(r.review_id), String(r.review_public_id)));
}

export interface ReceiptSourceBinding {
  /** Independently admitted resource creation/incarnation, not a database self-report. */
  target: string;
  epoch: string;
  schema: number;
}
export interface ReceiptAdmissionState {
  /** Monotonic external revision, persisted independently of the recoverable database. */
  revision: number;
  binding: ReceiptSourceBinding | null;
  prefix: string;
  /** Confirmed report prefix, committed by the external owner before ACK. */
  reportedThrough?: string;
  /** Retired incarnations stay in the external owner's durable state across code rollback. */
  retiredTargets?: readonly string[];
}
export interface ReceiptPageProposal {
  revision: number;
  binding: ReceiptSourceBinding;
  after: string;
  through: string;
  rows: Record<string, unknown>[];
}
const sameBinding = (a: ReceiptSourceBinding | null, b: ReceiptSourceBinding) =>
  a?.target === b.target && a.epoch === b.epoch && a.schema === b.schema;

/** A recovery cut affects correlation admission, never application work or recovery. */
export function closeReceiptAdmission(state: ReceiptAdmissionState): ReceiptAdmissionState {
  return { ...state, revision: state.revision + 1, binding: null,
    reportedThrough: undefined,
    retiredTargets: [...new Set([...(state.retiredTargets ?? []),
      ...(state.binding ? [state.binding.target] : [])])] };
}

/** Called by the existing admission owner under the same durable lock as cut and ACK.
 * The old source prefix remains retained in that owner's source-specific state.
 */
export function admitReceiptSource(state: ReceiptAdmissionState, binding: ReceiptSourceBinding,
  expectedRevision: number, sourcePrefix: string): ReceiptAdmissionState | null {
  if (sameBinding(state.binding, binding) && state.revision === expectedRevision + 1) return state;
  if (state.binding || state.revision !== expectedRevision || !binding.target
    || !binding.epoch || binding.schema !== 1 || state.retiredTargets?.includes(binding.target)
    || !/^(0|[1-9][0-9]{0,18})$/.test(sourcePrefix)) return null;
  return { ...state, revision: state.revision + 1, binding: { ...binding }, prefix: sourcePrefix,
    reportedThrough: undefined };
}

/** The admission owner serializes this update and ACK with its durable state commit. */
export function receiptPageAdmitted(state: ReceiptAdmissionState, page: ReceiptPageProposal): boolean {
  return sameBinding(state.binding, page.binding) && state.revision === page.revision
    && state.prefix === page.after;
}

/** The existing report owner commits this only after confirmed delivery under its admission lock. */
export function recordReceiptPageReported(state: ReceiptAdmissionState, page: ReceiptPageProposal,
  through: string): ReceiptAdmissionState | null {
  if (!receiptPageAdmitted(state, page) || (through !== page.after
    && !page.rows.some((row) => row.receipt_id === through))) return null;
  return { ...state, reportedThrough: through };
}

/** Check admission under the owner's lock before delivery, and again before ACK. */
export function acknowledgeReceiptPage(state: ReceiptAdmissionState, page: ReceiptPageProposal,
  reportedThrough: string): ReceiptAdmissionState | null {
  if (!receiptPageAdmitted(state, page) || !/^(0|[1-9][0-9]*)$/.test(reportedThrough)
    || !state.reportedThrough || BigInt(reportedThrough) > BigInt(state.reportedThrough)) return null;
  // Only a genuinely reported prefix of this exact page may advance the cursor.
  if (reportedThrough !== page.after && !page.rows.some((r) => r.receipt_id === reportedThrough)) return null;
  return { ...state, prefix: reportedThrough, reportedThrough: undefined };
}

/** The target witness comes from the admitted executor, outside SQL/stdout content. */
export async function readAdmittedReceiptPage(
  state: ReceiptAdmissionState,
  execute: (text: string, values: unknown[]) => Promise<{
    target: string; rows: Record<string, unknown>[];
  }>,
): Promise<{ status: "UNKNOWN" } | { status: "READY"; page: ReceiptPageProposal }> {
  if (!state.binding || !/^(0|[1-9][0-9]{0,18})$/.test(state.prefix)) return { status: "UNKNOWN" };
  const snapshot = { ...state, binding: { ...state.binding } };
  try {
    const response = await execute(readAttemptReceiptPageSql, [snapshot.prefix]);
    const columns = ["source_epoch", "schema_version", "anchor_id", "head_id", "receipt_id",
      "predecessor_id", "claim_receipt_id", "job_id", "ordinal", "job_kind", "review_id",
      "review_public_id", "event_kind", "outcome", "phase", "category", "recovered", "recovery", "occurred_at"];
    if (!Array.isArray(response.rows) || response.rows.length > 64) return { status: "UNKNOWN" };
    for (const row of response.rows) {
      if (!row || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) return { status: "UNKNOWN" };
      const fields = Object.getOwnPropertyDescriptors(row);
      if (Reflect.ownKeys(fields).length !== columns.length || columns.some((name) => {
        const field = fields[name];
        if (!field || !("value" in field)) return true;
        const value = field.value;
        return value !== null && !(typeof value === "string" && value.length <= 64)
          && !(typeof value === "number" && Number.isSafeInteger(value)) && typeof value !== "boolean";
      })) return { status: "UNKNOWN" };
    }
    const control = response.rows[0];
    if (response.target !== snapshot.binding.target || !control
      || control.source_epoch !== snapshot.binding.epoch || control.schema_version !== snapshot.binding.schema
      || control.anchor_id !== snapshot.prefix || typeof control.head_id !== "string"
      || BigInt(control.head_id) < BigInt(snapshot.prefix)
      || Buffer.byteLength(JSON.stringify(response.rows)) > 65536) {
      return { status: "UNKNOWN" };
    }
    let predecessor = snapshot.prefix;
    const rows = response.rows.filter((r) => r.receipt_id !== null);
    for (const row of rows) {
      if (row.source_epoch !== control.source_epoch || row.schema_version !== control.schema_version
        || row.anchor_id !== control.anchor_id || row.head_id !== control.head_id
        || typeof row.receipt_id !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.receipt_id)
        || row.predecessor_id !== predecessor || BigInt(row.receipt_id) <= BigInt(predecessor)
        || BigInt(row.receipt_id) > BigInt(control.head_id)) return { status: "UNKNOWN" };
      predecessor = row.receipt_id;
    }
    return { status: "READY", page: { revision: snapshot.revision, binding: snapshot.binding,
      after: snapshot.prefix, through: predecessor, rows } };
  } catch { return { status: "UNKNOWN" }; }
}


/** Called after the caller's locked administrative mutations and before its append tail. */
export async function prepareClosedJobReceipts(client: ReceiptClient,
  jobIds: readonly string[], outcome?: PreparedReceipt["outcome"]): Promise<PreparedReceipt[]> {
  if (!jobIds.length) return [];
  const result = await client.query(`SELECT j.id::text, j.status, c.ordinal, c.receipt_id::text
    FROM jobs j JOIN job_attempt_receipts c ON c.receipt_id = j.active_claim_receipt_id
    WHERE j.id = ANY($1::bigint[]) AND j.status <> 'running' AND c.event_kind = 'claim'
      AND NOT EXISTS (SELECT 1 FROM job_attempt_receipts x
        WHERE x.claim_receipt_id = c.receipt_id AND x.event_kind = 'queue_closed')
    ORDER BY j.id`, [jobIds]);
  if (result.rows.length) await client.query(`UPDATE jobs SET active_claim_receipt_id = NULL
    WHERE id = ANY($1::bigint[])`, [result.rows.map((r) => r.id)]);
  return result.rows.map((r) => claimEvent(String(r.id), Number(r.ordinal), String(r.receipt_id),
    "queue_closed", outcome ?? (r.status === "queued" ? "retry" : r.status === "failed" ? "failed" : "cancelled")));
}
