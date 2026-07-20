import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { apiBase, getAppJwt } from "@/lib/github/app-auth";

const DELIVERY_LOOKBACK_MS = 71 * 60 * 60 * 1_000;
const DELIVERY_SETTLE_MS = 60_000;
const SCAN_LEASE_MS = 5 * 60 * 1_000;
const AMBIGUOUS_RETRY_MS = 10 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES_PER_PASS = 3;
const MAX_REDELIVERIES_PER_PASS = 10;
const MAX_REQUEST_ATTEMPTS = 2;
const MAX_GUID_REQUEST_ATTEMPTS = 3;
const RATE_LIMIT_RESERVE = 25;
const MAX_RESPONSE_BYTES = 1_000_000;
const RECOVERY_METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RECOVERY_METADATA_PRUNE_BATCH = 1_000;

const deliveryIdSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

const deliverySchema = z.object({
  id: deliveryIdSchema,
  guid: z.string().min(1).max(128),
  delivered_at: z.string().datetime({ offset: true }),
  redelivery: z.boolean(),
  status: z.string().min(1).max(80),
  status_code: z.number().int().nullable(),
  event: z.string().min(1).max(120),
});

type Delivery = z.infer<typeof deliverySchema>;
type FetchLike = typeof fetch;

interface Candidate {
  deliveryId: string;
  requestAttempts: number;
}

interface PageResult {
  deliveries: Delivery[];
  nextCursor: string | null;
  remaining: number | null;
  resetAt: Date | null;
}

type RequestState = "accepted" | "retryable" | "terminal" | "exhausted" | "lost";

interface RedeliveryResult {
  state: RequestState;
  rateLimitedUntil: Date | null;
}

export interface WebhookRedeliveryPassResult {
  claimed: boolean;
  pages: number;
  observed: number;
  requested: number;
  accepted: number;
  retryable: number;
  terminal: number;
  exhausted: number;
  recovered: number;
  rateLimitedUntil: Date | null;
}

export interface WebhookRedeliveryPassOptions {
  now?: Date;
  owner?: string;
  fetchImpl?: FetchLike;
  appJwt?: string;
  maxPages?: number;
  maxRedeliveries?: number;
  signal?: AbortSignal;
}

export class GitHubWebhookRecoveryError extends Error {
  override name = "GitHubWebhookRecoveryError";

  constructor(
    readonly category: string,
    message: string,
    readonly retryAt: Date | null = null,
  ) {
    super(message);
  }
}

function emptyResult(claimed: boolean): WebhookRedeliveryPassResult {
  return {
    claimed,
    pages: 0,
    observed: 0,
    requested: 0,
    accepted: 0,
    retryable: 0,
    terminal: 0,
    exhausted: 0,
    recovered: 0,
    rateLimitedUntil: null,
  };
}

function integerHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function retryAt(response: Response, now: Date): Date | null {
  const retryAfter = integerHeader(response, "retry-after");
  if (retryAfter !== null) return new Date(now.getTime() + retryAfter * 1_000);
  const reset = integerHeader(response, "x-ratelimit-reset");
  return reset === null ? null : new Date(reset * 1_000);
}

function responseIsRateLimited(response: Response): boolean {
  return response.status === 429 ||
    (response.status === 403 &&
      (integerHeader(response, "x-ratelimit-remaining") === 0 ||
        integerHeader(response, "retry-after") !== null));
}

function deliveryListUrl(base: string): URL {
  return new URL(`${base.replace(/\/$/, "")}/app/hook/deliveries`);
}

function nextCursor(link: string | null, base: string): string | null {
  if (link === null) return null;
  const expected = deliveryListUrl(base);
  for (const part of link.split(",")) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
    if (!match?.[1]) continue;
    const target = new URL(match[1]);
    if (target.origin !== expected.origin || target.pathname !== expected.pathname) {
      throw new GitHubWebhookRecoveryError(
        "invalid_pagination",
        "GitHub delivery pagination pointed outside the App delivery endpoint",
      );
    }
    const cursor = target.searchParams.get("cursor");
    if (cursor === null || cursor.length === 0 || cursor.length > 512) {
      throw new GitHubWebhookRecoveryError(
        "invalid_pagination",
        "GitHub delivery pagination returned an invalid cursor",
      );
    }
    return cursor;
  }
  return null;
}

function parseDeliveryJson(text: string): unknown {
  // GitHub declares delivery IDs as int64 JSON numbers. Preserve their decimal
  // representation before JSON.parse rounds values above Number.MAX_SAFE_INTEGER.
  const losslessDeliveryIds = text.replace(
    /("id"\s*:\s*)(\d+)(?=\s*[,}])/g,
    '$1"$2"',
  );
  return JSON.parse(losslessDeliveryIds);
}

async function boundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new GitHubWebhookRecoveryError(
      "oversized_response",
      "GitHub delivery response exceeded the bounded response size",
    );
  }
  if (response.body === null) {
    throw new GitHubWebhookRecoveryError(
      "invalid_response",
      "GitHub delivery response did not include a body",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubWebhookRecoveryError(
          "oversized_response",
          "GitHub delivery response exceeded the bounded response size",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof GitHubWebhookRecoveryError) throw error;
    if (signal?.aborted) {
      throw new GitHubWebhookRecoveryError("aborted", "GitHub delivery listing was cancelled");
    }
    throw new GitHubWebhookRecoveryError(
      "transport",
      "GitHub delivery response failed while it was being read",
    );
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return parseDeliveryJson(new TextDecoder().decode(bytes));
  } catch {
    throw new GitHubWebhookRecoveryError(
      "invalid_response",
      "GitHub delivery response was not valid JSON",
    );
  }
}

async function fetchDeliveryPage(
  cursor: string | null,
  jwt: string,
  fetchImpl: FetchLike,
  now: Date,
  signal?: AbortSignal,
): Promise<PageResult> {
  const base = apiBase();
  const url = deliveryListUrl(base);
  url.searchParams.set("per_page", "100");
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: githubHeaders(jwt),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    if (signal?.aborted) {
      throw new GitHubWebhookRecoveryError("aborted", "GitHub delivery listing was cancelled");
    }
    throw new GitHubWebhookRecoveryError(
      "transport",
      "GitHub delivery listing failed before a response was received",
    );
  }
  if (!response.ok) {
    const category = responseIsRateLimited(response)
      ? "rate_limited"
      : cursor !== null && (response.status === 400 || response.status === 422)
        ? "invalid_cursor"
        : "api";
    throw new GitHubWebhookRecoveryError(
      category,
      `GitHub delivery listing returned HTTP ${response.status}`,
      category === "rate_limited" ? retryAt(response, now) : null,
    );
  }
  const parsed = z.array(deliverySchema).max(100).safeParse(await boundedJson(response, signal));
  if (!parsed.success) {
    throw new GitHubWebhookRecoveryError(
      "invalid_response",
      "GitHub delivery listing did not match the bounded delivery schema",
    );
  }
  const reset = integerHeader(response, "x-ratelimit-reset");
  return {
    deliveries: parsed.data,
    nextCursor: nextCursor(response.headers.get("link"), base),
    remaining: integerHeader(response, "x-ratelimit-remaining"),
    resetAt: reset === null ? null : new Date(reset * 1_000),
  };
}

function githubHeaders(jwt: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${jwt}`,
    "User-Agent": "postil-webhook-recovery",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function outcome(delivery: Delivery): "success" | "failure" | "pending" {
  const statusCode = delivery.status_code;
  if (delivery.status.toLowerCase() === "pending") return "pending";
  if (delivery.status === "OK" || (statusCode !== null && statusCode >= 200 && statusCode <= 399)) {
    return "success";
  }
  return "failure";
}

async function claimSweep(
  pool: Pool,
  owner: string,
  now: Date,
): Promise<{ cursor: string | null; sweepStartedAt: Date } | null> {
  const leaseExpiresAt = new Date(now.getTime() + SCAN_LEASE_MS);
  await pool.query(
    `INSERT INTO github_webhook_redelivery_state (id)
     VALUES (1)
     ON CONFLICT (id) DO NOTHING`,
  );
  const result = await pool.query<{ cursor: string | null; sweep_started_at: Date }>(
    `UPDATE github_webhook_redelivery_state
        SET cursor = CASE
              WHEN cursor IS NOT NULL AND sweep_started_at IS NULL THEN NULL
              ELSE cursor
            END,
            lease_owner = $1,
            lease_expires_at = $2,
            sweep_started_at = CASE
              WHEN cursor IS NULL OR sweep_started_at IS NULL THEN $3
              ELSE sweep_started_at
            END,
            last_error_category = NULL
      WHERE id = 1
        AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
        AND (rate_limited_until IS NULL OR rate_limited_until <= $3)
      RETURNING cursor, sweep_started_at`,
    [owner, leaseExpiresAt, now],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { cursor: row.cursor, sweepStartedAt: row.sweep_started_at };
}

async function releaseSweep(
  pool: Pool,
  owner: string,
  input: {
    now: Date;
    cursor: string | null;
    completed: boolean;
    rateLimitedUntil?: Date | null;
    errorCategory?: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE github_webhook_redelivery_state
        SET cursor = $1,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_page_at = CASE WHEN $2::boolean THEN $3 ELSE last_page_at END,
            last_sweep_completed_at = CASE WHEN $4::boolean THEN $3 ELSE last_sweep_completed_at END,
            rate_limited_until = $5,
            last_error_category = $6
      WHERE id = 1 AND lease_owner = $7`,
    [
      input.cursor,
      input.errorCategory === undefined,
      input.now,
      input.completed,
      input.rateLimitedUntil ?? null,
      input.errorCategory ?? null,
      owner,
    ],
  );
}

async function persistPage(
  client: PoolClient,
  deliveries: Delivery[],
  now: Date,
  cutoff: Date,
  settledBefore: Date,
  limit: number,
  sweepStartedAt: Date,
): Promise<{ candidates: Candidate[]; recovered: number; exhausted: number }> {
  for (const delivery of deliveries) {
    const deliveryOutcome = outcome(delivery);
    await client.query(
      `INSERT INTO github_webhook_delivery_recoveries
         (delivery_id, delivery_guid, delivered_at, event, redelivery, outcome, status_code, observed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (delivery_id) DO UPDATE
         SET delivery_guid = EXCLUDED.delivery_guid,
             delivered_at = EXCLUDED.delivered_at,
             event = EXCLUDED.event,
             redelivery = EXCLUDED.redelivery,
             outcome = EXCLUDED.outcome,
             status_code = EXCLUDED.status_code,
             observed_at = EXCLUDED.observed_at,
             updated_at = EXCLUDED.updated_at`,
      [
        delivery.id,
        delivery.guid,
        new Date(delivery.delivered_at),
        delivery.event,
        delivery.redelivery,
        deliveryOutcome,
        delivery.status_code,
        now,
      ],
    );
  }

  const recovered = await client.query(
    `WITH recovery AS (
       SELECT failed.delivery_id AS failed_delivery_id,
              (
                SELECT success.delivery_id
                  FROM github_webhook_delivery_recoveries AS success
                 WHERE success.delivery_guid = failed.delivery_guid
                   AND success.outcome = 'success'
                   AND (success.delivered_at, success.delivery_id::numeric) >
                       (failed.delivered_at, failed.delivery_id::numeric)
                 ORDER BY success.delivered_at DESC, success.delivery_id::numeric DESC
                 LIMIT 1
              ) AS recovered_delivery_id
         FROM github_webhook_delivery_recoveries AS failed
        WHERE failed.outcome = 'failure'
          AND failed.recovery_delivery_id IS NULL
     )
     UPDATE github_webhook_delivery_recoveries AS failed
        SET recovery_delivery_id = recovery.recovered_delivery_id,
            request_state = CASE
              WHEN failed.request_state IS NULL THEN NULL
              ELSE 'recovered'
            END,
            updated_at = $1
       FROM recovery
      WHERE failed.delivery_id = recovery.failed_delivery_id
        AND recovery.recovered_delivery_id IS NOT NULL`,
    [now],
  );

  const exhausted = await client.query(
    `UPDATE github_webhook_delivery_recoveries AS failed
        SET request_state = 'exhausted',
            next_attempt_at = NULL,
            last_error_category = 'ambiguous_limit',
            updated_at = $1
      WHERE failed.outcome = 'failure'
        AND failed.recovery_delivery_id IS NULL
        AND COALESCE(failed.request_state, '') NOT IN ('terminal', 'exhausted', 'recovered')
        AND (
          (
            failed.request_state = 'requesting'
            AND failed.next_attempt_at <= $1
            AND failed.request_attempts >= $2
          )
          OR (
            SELECT COALESCE(sum(prior.request_attempts), 0)
              FROM github_webhook_delivery_recoveries AS prior
             WHERE prior.delivery_guid = failed.delivery_guid
          ) >= $3
        )`,
    [now, MAX_REQUEST_ATTEMPTS, MAX_GUID_REQUEST_ATTEMPTS],
  );

  const candidates = await client.query<Candidate>(
    `SELECT failed.delivery_id AS "deliveryId",
            failed.request_attempts AS "requestAttempts"
       FROM github_webhook_delivery_recoveries AS failed
      WHERE failed.outcome = 'failure'
        AND failed.recovery_delivery_id IS NULL
        AND failed.delivered_at >= $1
        AND failed.delivered_at <= $2
        AND failed.request_attempts < $3
        AND (
          failed.request_state IS NULL
          OR (
            failed.request_state IN ('retryable', 'requesting')
            AND failed.next_attempt_at <= $4
            AND failed.next_attempt_at <= $5
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM github_webhook_delivery_recoveries AS newer
           WHERE newer.delivery_guid = failed.delivery_guid
             AND (newer.delivered_at, newer.delivery_id::numeric) >
                 (failed.delivered_at, failed.delivery_id::numeric)
        )
        AND (
          SELECT COALESCE(sum(prior.request_attempts), 0)
            FROM github_webhook_delivery_recoveries AS prior
           WHERE prior.delivery_guid = failed.delivery_guid
        ) < $7
      ORDER BY failed.delivered_at, failed.delivery_id
      LIMIT $6`,
    [
      cutoff,
      settledBefore,
      MAX_REQUEST_ATTEMPTS,
      now,
      sweepStartedAt,
      limit,
      MAX_GUID_REQUEST_ATTEMPTS,
    ],
  );
  return {
    candidates: candidates.rows,
    recovered: recovered.rowCount ?? 0,
    exhausted: exhausted.rowCount ?? 0,
  };
}

async function pruneRecoveryMetadata(pool: Pool, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RECOVERY_METADATA_RETENTION_MS);
  const result = await pool.query(
    `WITH expired AS (
       SELECT ctid
         FROM github_webhook_delivery_recoveries
        WHERE delivered_at < $1
        ORDER BY delivered_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM github_webhook_delivery_recoveries AS delivery
      USING expired
      WHERE delivery.ctid = expired.ctid`,
    [cutoff, RECOVERY_METADATA_PRUNE_BATCH],
  );
  return result.rowCount ?? 0;
}

async function observePage(
  pool: Pool,
  deliveries: Delivery[],
  now: Date,
  remainingRequestBudget: number,
  sweepStartedAt: Date,
): Promise<{ candidates: Candidate[]; recovered: number; exhausted: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await persistPage(
      client,
      deliveries,
      now,
      new Date(now.getTime() - DELIVERY_LOOKBACK_MS),
      new Date(now.getTime() - DELIVERY_SETTLE_MS),
      remainingRequestBudget,
      sweepStartedAt,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function claimCandidate(pool: Pool, candidate: Candidate, now: Date): Promise<number | null> {
  const result = await pool.query<{ request_attempts: number }>(
    `UPDATE github_webhook_delivery_recoveries
        SET request_state = 'requesting',
            request_attempts = request_attempts + 1,
            last_requested_at = $2,
            next_attempt_at = $3,
            request_status_code = NULL,
            last_error_category = NULL,
            updated_at = $2
      WHERE delivery_id = $1
        AND outcome = 'failure'
        AND recovery_delivery_id IS NULL
        AND request_attempts = $4
        AND request_attempts < $5
        AND (
          request_state IS NULL
          OR (request_state IN ('retryable', 'requesting') AND next_attempt_at <= $2)
        )
      RETURNING request_attempts`,
    [
      candidate.deliveryId,
      now,
      new Date(now.getTime() + AMBIGUOUS_RETRY_MS),
      candidate.requestAttempts,
      MAX_REQUEST_ATTEMPTS,
    ],
  );
  return result.rows[0]?.request_attempts ?? null;
}

function requestFailureState(attempts: number): "retryable" | "exhausted" {
  return attempts >= MAX_REQUEST_ATTEMPTS ? "exhausted" : "retryable";
}

async function recordRequestResult(
  pool: Pool,
  deliveryId: string,
  now: Date,
  input: {
    state: "accepted" | "retryable" | "terminal" | "exhausted";
    statusCode: number | null;
    category: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE github_webhook_delivery_recoveries
        SET request_state = $2,
            request_status_code = $3,
            last_error_category = $4,
            next_attempt_at = CASE
              WHEN $2 = 'retryable' THEN $5::timestamptz
              ELSE NULL
            END,
            updated_at = $6
      WHERE delivery_id = $1`,
    [
      deliveryId,
      input.state,
      input.statusCode,
      input.category,
      new Date(now.getTime() + AMBIGUOUS_RETRY_MS),
      now,
    ],
  );
}

async function redeliver(
  deliveryId: string,
  jwt: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<Response> {
  const base = apiBase().replace(/\/$/, "");
  return await fetchImpl(`${base}/app/hook/deliveries/${deliveryId}/attempts`, {
    method: "POST",
    headers: githubHeaders(jwt),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function requestRedelivery(
  pool: Pool,
  candidate: Candidate,
  jwt: string,
  fetchImpl: FetchLike,
  now: Date,
  signal?: AbortSignal,
): Promise<RedeliveryResult> {
  const attempts = await claimCandidate(pool, candidate, now);
  if (attempts === null) return { state: "lost", rateLimitedUntil: null };
  let response: Response;
  try {
    response = await redeliver(candidate.deliveryId, jwt, fetchImpl, signal);
  } catch {
    if (signal?.aborted) {
      throw new GitHubWebhookRecoveryError("aborted", "GitHub redelivery request was cancelled");
    }
    const state = requestFailureState(attempts);
    await recordRequestResult(pool, candidate.deliveryId, now, {
      state,
      statusCode: null,
      category: "transport",
    });
    return { state, rateLimitedUntil: null };
  }
  if (response.status === 202) {
    await recordRequestResult(pool, candidate.deliveryId, now, {
      state: "accepted",
      statusCode: 202,
      category: null,
    });
    return { state: "accepted", rateLimitedUntil: null };
  }
  const rateLimited = responseIsRateLimited(response);
  const retryable = rateLimited || response.status >= 500;
  const state = retryable ? requestFailureState(attempts) : "terminal";
  await recordRequestResult(pool, candidate.deliveryId, now, {
    state,
    statusCode: response.status,
    category: retryable ? "api_retryable" : "api_terminal",
  });
  return {
    state,
    rateLimitedUntil: rateLimited
      ? retryAt(response, now) ?? new Date(now.getTime() + 60_000)
      : null,
  };
}

function oldestDelivery(deliveries: Delivery[]): Date | null {
  let oldest: Date | null = null;
  for (const delivery of deliveries) {
    const deliveredAt = new Date(delivery.delivered_at);
    if (oldest === null || deliveredAt < oldest) oldest = deliveredAt;
  }
  return oldest;
}

export async function runWebhookRedeliveryPass(
  pool: Pool,
  options: WebhookRedeliveryPassOptions = {},
): Promise<WebhookRedeliveryPassResult> {
  const now = options.now ?? new Date();
  const owner = options.owner ?? `worker-${process.pid}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxPages = Math.min(
    Math.max(options.maxPages ?? MAX_PAGES_PER_PASS, 1),
    MAX_PAGES_PER_PASS,
  );
  const maxRedeliveries = Math.min(
    Math.max(options.maxRedeliveries ?? MAX_REDELIVERIES_PER_PASS, 0),
    MAX_REDELIVERIES_PER_PASS,
  );
  const claim = await claimSweep(pool, owner, now);
  if (claim === null) return emptyResult(false);

  const result = emptyResult(true);
  let cursor = claim.cursor;
  const sweepStartedAt = claim.sweepStartedAt;
  let completed = false;
  let rateLimitedUntil: Date | null = null;
  try {
    await pruneRecoveryMetadata(pool, now);
    const jwt = options.appJwt ?? getAppJwt(now.getTime());
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await fetchDeliveryPage(cursor, jwt, fetchImpl, now, options.signal);
      result.pages += 1;
      result.observed += page.deliveries.length;
      const cutoff = new Date(now.getTime() - DELIVERY_LOOKBACK_MS);
      const oldest = oldestDelivery(page.deliveries);
      const completesSweep = page.nextCursor === null || page.deliveries.length === 0 ||
        (oldest !== null && oldest < cutoff);
      const passBudget = Math.max(maxRedeliveries - result.requested, 0);
      const rateBudget = page.remaining === null
        ? passBudget
        : Math.max(page.remaining - RATE_LIMIT_RESERVE, 0);
      const remainingBudget = completesSweep ? Math.min(passBudget, rateBudget) : 0;
      const observed = await observePage(
        pool,
        page.deliveries,
        now,
        remainingBudget,
        sweepStartedAt,
      );
      result.recovered += observed.recovered;
      result.exhausted += observed.exhausted;

      const lowRateLimit = page.remaining !== null && page.remaining <= RATE_LIMIT_RESERVE;
      if (completesSweep && !lowRateLimit) {
        for (const candidate of observed.candidates) {
          if (result.requested >= maxRedeliveries) break;
          const requestResult = await requestRedelivery(
            pool,
            candidate,
            jwt,
            fetchImpl,
            now,
            options.signal,
          );
          if (requestResult.state === "lost") continue;
          result.requested += 1;
          result[requestResult.state] += 1;
          if (requestResult.rateLimitedUntil !== null) {
            rateLimitedUntil = requestResult.rateLimitedUntil;
            break;
          }
        }
      }

      completed = completesSweep;
      cursor = completed ? null : page.nextCursor;
      if (lowRateLimit && rateLimitedUntil === null) {
        rateLimitedUntil = page.resetAt ?? new Date(now.getTime() + 60_000);
      }
      if (rateLimitedUntil !== null) {
        break;
      }
      if (completed) break;
    }

    result.rateLimitedUntil = rateLimitedUntil;
    await releaseSweep(pool, owner, {
      now,
      cursor,
      completed,
      rateLimitedUntil,
    });
    return result;
  } catch (error) {
    const recoveryError = error instanceof GitHubWebhookRecoveryError ? error : null;
    const resetCursor = recoveryError?.category === "invalid_cursor" ||
      recoveryError?.category === "invalid_pagination";
    await releaseSweep(pool, owner, {
      now,
      cursor: resetCursor ? null : cursor,
      completed: false,
      rateLimitedUntil: recoveryError?.retryAt ?? null,
      errorCategory: recoveryError?.category ?? "internal",
    });
    throw error;
  }
}
