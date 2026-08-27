import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";

import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";

import type { ApiFormat } from "@/lib/byok-provider";
import { isPrivateIpLiteral } from "@/lib/api-base";
import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { HOSTED_REVIEW_RESERVATION_TTL_MS } from "@/lib/hosted-usage-reservations";

const RUN_TTL_MS = 24 * 60 * 60 * 1_000;
const ATTEMPT_LEASE_MS = 8 * 60 * 1_000;
const MAX_PROVIDER_REQUEST_BYTES = 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_REGISTRATION_BYTES = 16 * 1024;
const PLAN_REGISTRATION_VERSION = 1;
const MAX_OPENROUTER_ATTEMPTS = 8;
const OPENROUTER_FAILURE_STATUSES = new Set([502, 503, 504, 529]);
const SAFE_PROVIDER_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,78}[A-Za-z0-9])?$/;
const URL_LIKE_PROVIDER_LABEL = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)/i;
const TOKEN_LIKE_PROVIDER_LABELS = [
  /^(?:bearer|basic)\s+/i,
  /^(?:sk|rk|pk|key|token|secret|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{12,}$/i,
  /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
  /^[A-Fa-f0-9]{32,}$/,
];

export interface LargeReviewRunIdentity {
  repositoryId: number;
  prNumber: number;
  cliVersion: string;
  configurationSha256: string;
  providerIdentity: string;
  headSha: string;
  baseSha: string;
  retryLineage: string;
  planSha256: string;
}

export interface LargeReviewRunContext {
  currentReviewId: number;
  hostedReservationId: string | null;
  expectedRunKey?: string;
}

export interface StoredProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface OpenRouterProviderAttempt {
  ordinal: number;
  provider: string;
  status: number;
}

export interface OpenRouterFailureInspection {
  body: string;
  attempts: OpenRouterProviderAttempt[];
}

export type LargeReviewProviderDiagnostic =
  | {
      event: "postil.large_review.provider_failure";
      source: "upstream";
      review_id: number;
      request_sha256: string;
      upstream_status: number;
      attempt_ordinal: number;
      provider: string;
      attempted_status: number;
    }
  | {
      event: "postil.large_review.provider_failure";
      source: "gateway";
      review_id: number;
      request_sha256: string;
      gateway_status: number;
      request_attempt: number;
    };

export type AttemptClaim =
  | { kind: "execute"; attemptKey: string; leaseId: string }
  | { kind: "replay"; response: StoredProviderResponse }
  | { kind: "pending" };

export interface LargeReviewAttemptStore {
  bindRun(
    identity: LargeReviewRunIdentity,
    context: LargeReviewRunContext,
  ): Promise<string>;
  claimAttempt(input: {
    runKey: string;
    requestSha256: string;
    batchIdentity: string;
    attempt: number;
    model: string;
  }): Promise<AttemptClaim>;
  completeAttempt(input: {
    attemptKey: string;
    leaseId: string;
    response: StoredProviderResponse;
  }): Promise<void>;
  abandonAttempt(attemptKey: string, leaseId: string): Promise<void>;
  deleteRun(runKey: string): Promise<void>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableRunIdentity(identity: LargeReviewRunIdentity): string {
  return [
    "large-review-run-v1",
    String(identity.repositoryId),
    String(identity.prNumber),
    identity.cliVersion,
    identity.configurationSha256,
    identity.providerIdentity,
    identity.headSha,
    identity.baseSha,
    identity.retryLineage,
    identity.planSha256,
  ].join("\0");
}

export function largeReviewRunKey(identity: LargeReviewRunIdentity): string {
  return sha256(stableRunIdentity(identity));
}

export function largeReviewAttemptKey(input: {
  runKey: string;
  requestSha256: string;
  batchIdentity: string;
  attempt: number;
  model: string;
}): string {
  return sha256(
    [
      "large-review-attempt-v1",
      input.runKey,
      input.requestSha256,
      input.batchIdentity,
      String(input.attempt),
      input.model,
    ].join("\0"),
  );
}

export async function hashEffectiveReviewConfiguration(
  workDir: string,
  configFiles: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("postil-effective-configuration-v1\0");
  for (const label of [...configFiles].sort()) {
    const path = label.replace(/^(?:shared|org):/, "");
    const body = await readFile(join(workDir, path));
    hash.update(label);
    hash.update("\0");
    hash.update(body);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function providerIdentity(input: {
  apiBase: string;
  apiFormat: ApiFormat;
  byok: boolean;
  apiKey?: string;
  apiAuthHeader?: string;
  apiAuthValue?: string;
  identityKey: string | Uint8Array;
}): string {
  const url = new URL(input.apiBase);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  const authIdentity = createHmac("sha256", input.identityKey)
    .update("postil-provider-auth-v1\0")
    .update(input.apiKey ?? "")
    .update("\0")
    .update(input.apiAuthHeader?.toLowerCase() ?? "")
    .update("\0")
    .update(input.apiAuthValue ?? "")
    .digest("hex");
  return JSON.stringify([
    input.byok ? "byok" : "managed",
    input.apiFormat,
    url.toString(),
    authIdentity,
  ]);
}

export function privateUpstreamAllowed(input: {
  byok: boolean;
  configuredOptIn?: string;
}): boolean {
  return (
    !input.byok &&
    ["1", "true"].includes(input.configuredOptIn?.trim().toLowerCase() ?? "")
  );
}

export class PostgresLargeReviewAttemptStore implements LargeReviewAttemptStore {
  constructor(private readonly db: Database) {}

  async bindRun(
    identity: LargeReviewRunIdentity,
    context: LargeReviewRunContext,
  ): Promise<string> {
    const now = new Date();
    const runKey = largeReviewRunKey(identity);
    const storedContext = {
      currentReviewId: context.currentReviewId,
      hostedReservationId: context.hostedReservationId,
    };
    const ownsRun = (key: string) =>
      and(
        eq(schema.largeReviewRuns.runKey, key),
        eq(schema.largeReviewRuns.currentReviewId, context.currentReviewId),
        context.hostedReservationId === null
          ? isNull(schema.largeReviewRuns.hostedReservationId)
          : eq(
              schema.largeReviewRuns.hostedReservationId,
              context.hostedReservationId,
            ),
        eq(schema.largeReviewRuns.billingState, "active"),
      );
    return this.db.transaction(async (tx) => {
      if (context.expectedRunKey && context.expectedRunKey !== runKey) {
        // A retry replans from scratch and the planner is model-driven, so the
        // new plan rarely hashes to the one the previous attempt registered.
        // The attempts cached under the old key answer provider requests this
        // plan will never make. Retire that run and bind the new plan under the
        // reservation the retry already inherited: refusing instead spends the
        // retry and reports an operational failure for work that can still be
        // done. Ownership still gates the retirement, so a run held by another
        // review or already settled conservatively is never discarded here.
        const retired = await tx
          .delete(schema.largeReviewRuns)
          .where(ownsRun(context.expectedRunKey))
          .returning({ runKey: schema.largeReviewRuns.runKey });
        if (retired.length !== 1) {
          throw new Error("large-review run context ownership collision");
        }
      }
      await tx
        .delete(schema.largeReviewRuns)
        .where(lte(schema.largeReviewRuns.expiresAt, now));
      await tx
        .insert(schema.largeReviewRuns)
        .values({
          runKey,
          ...identity,
          ...storedContext,
          expiresAt: new Date(now.getTime() + RUN_TTL_MS),
        })
        .onConflictDoNothing();
      const stored = (
        await tx
          .select()
          .from(schema.largeReviewRuns)
          .where(eq(schema.largeReviewRuns.runKey, runKey))
          .limit(1)
      )[0];
      if (
        !stored ||
        stored.repositoryId !== identity.repositoryId ||
        stored.prNumber !== identity.prNumber ||
        stored.cliVersion !== identity.cliVersion ||
        stored.configurationSha256 !== identity.configurationSha256 ||
        stored.providerIdentity !== identity.providerIdentity ||
        stored.headSha !== identity.headSha ||
        stored.baseSha !== identity.baseSha ||
        stored.retryLineage !== identity.retryLineage ||
        stored.planSha256 !== identity.planSha256
      ) {
        throw new Error("large-review run identity collision");
      }
      const rebound = await tx
        .update(schema.largeReviewRuns)
        .set({
          expiresAt: new Date(now.getTime() + RUN_TTL_MS),
        })
        .where(ownsRun(runKey))
        .returning({ runKey: schema.largeReviewRuns.runKey });
      if (rebound.length !== 1) {
        throw new Error("large-review run context ownership collision");
      }
      return runKey;
    });
  }

  async claimAttempt(input: {
    runKey: string;
    requestSha256: string;
    batchIdentity: string;
    attempt: number;
    model: string;
  }): Promise<AttemptClaim> {
    const attemptKey = largeReviewAttemptKey(input);
    const replayable = (
      await this.db
        .select()
        .from(schema.largeReviewAttempts)
        .where(
          and(
            eq(schema.largeReviewAttempts.runKey, input.runKey),
            eq(schema.largeReviewAttempts.requestSha256, input.requestSha256),
            eq(schema.largeReviewAttempts.state, "completed"),
          ),
        )
        .orderBy(asc(schema.largeReviewAttempts.attempt))
        .limit(1)
    )[0];
    if (replayable) {
      if (
        replayable.responseStatus === null ||
        replayable.responseHeaders === null ||
        replayable.responseBody === null
      ) {
        throw new Error("completed large-review attempt lacks its response");
      }
      return {
        kind: "replay",
        response: {
          status: replayable.responseStatus,
          headers: replayable.responseHeaders,
          body: replayable.responseBody,
        },
      };
    }
    const existing = (
      await this.db
        .select()
        .from(schema.largeReviewAttempts)
        .where(
          and(
            eq(schema.largeReviewAttempts.runKey, input.runKey),
            eq(schema.largeReviewAttempts.requestSha256, input.requestSha256),
            eq(schema.largeReviewAttempts.state, "pending"),
          ),
        )
        .limit(1)
    )[0];
    const now = new Date();
    const leaseId = randomUUID();
    if (!existing) {
      const inserted = await this.db
        .insert(schema.largeReviewAttempts)
        .values({
          attemptKey,
          ...input,
          state: "pending",
          leaseId,
          leaseExpiresAt: new Date(now.getTime() + ATTEMPT_LEASE_MS),
        })
        .onConflictDoNothing()
        .returning({ attemptKey: schema.largeReviewAttempts.attemptKey });
      if (inserted.length === 1) {
        return { kind: "execute", attemptKey, leaseId };
      }
      return this.claimAttempt(input);
    }

    const reclaimed = await this.db
      .update(schema.largeReviewAttempts)
      .set({
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + ATTEMPT_LEASE_MS),
      })
      .where(
        and(
          eq(schema.largeReviewAttempts.attemptKey, existing.attemptKey),
          eq(schema.largeReviewAttempts.state, "pending"),
          lte(schema.largeReviewAttempts.leaseExpiresAt, now),
        ),
      )
      .returning({ attemptKey: schema.largeReviewAttempts.attemptKey });
    return reclaimed.length === 1
      ? { kind: "execute", attemptKey: reclaimed[0]!.attemptKey, leaseId }
      : { kind: "pending" };
  }

  async completeAttempt(input: {
    attemptKey: string;
    leaseId: string;
    response: StoredProviderResponse;
  }): Promise<void> {
    const completed = await this.db
      .update(schema.largeReviewAttempts)
      .set({
        state: "completed",
        responseStatus: input.response.status,
        responseHeaders: input.response.headers,
        responseBody: input.response.body,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.largeReviewAttempts.attemptKey, input.attemptKey),
          eq(schema.largeReviewAttempts.leaseId, input.leaseId),
          eq(schema.largeReviewAttempts.state, "pending"),
        ),
      )
      .returning({ attemptKey: schema.largeReviewAttempts.attemptKey });
    if (completed.length !== 1) {
      throw new Error("large-review attempt lost its persistence lease");
    }
  }

  async abandonAttempt(attemptKey: string, leaseId: string): Promise<void> {
    await this.db
      .delete(schema.largeReviewAttempts)
      .where(
        and(
          eq(schema.largeReviewAttempts.attemptKey, attemptKey),
          eq(schema.largeReviewAttempts.leaseId, leaseId),
          eq(schema.largeReviewAttempts.state, "pending"),
        ),
      );
  }

  async deleteRun(runKey: string): Promise<void> {
    await this.db
      .delete(schema.largeReviewRuns)
      .where(eq(schema.largeReviewRuns.runKey, runKey));
  }
}

export type ReusableLargeReviewReservation =
  | { kind: "none" }
  | { kind: "resume"; reservationId: string; expectedRunKey: string }
  | { kind: "conservatively-settled" };

export async function claimReusableLargeReviewReservation(
  db: Database,
  identity: Omit<LargeReviewRunIdentity, "planSha256">,
  currentReviewId: number,
): Promise<ReusableLargeReviewReservation> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + HOSTED_REVIEW_RESERVATION_TTL_MS);
  return db.transaction(async (tx) => {
    const selected = await tx.execute(sql`
      SELECT run.run_key, run.current_review_id, run.hosted_reservation_id,
             run.billing_state, reservation.status AS reservation_status,
             reservation.expires_at AS reservation_expires_at,
             reservation.operation AS reservation_operation
        FROM large_review_runs run
        LEFT JOIN hosted_usage_reservations reservation
          ON reservation.id = run.hosted_reservation_id
       WHERE run.repository_id = ${identity.repositoryId}
         AND run.pr_number = ${identity.prNumber}
         AND run.cli_version = ${identity.cliVersion}
         AND run.configuration_sha256 = ${identity.configurationSha256}
         AND run.provider_identity = ${identity.providerIdentity}
         AND run.head_sha = ${identity.headSha}
         AND run.base_sha = ${identity.baseSha}
         AND run.retry_lineage = ${identity.retryLineage}
         AND run.expires_at > ${now}
       ORDER BY run.created_at DESC
       FOR UPDATE OF run
       LIMIT 1
    `);
    const row = selected.rows[0] as
      | {
          run_key: string;
          current_review_id: string;
          hosted_reservation_id: string | null;
          billing_state: string;
          reservation_status: string | null;
          reservation_expires_at: Date | null;
          reservation_operation: string | null;
        }
      | undefined;
    if (!row) return { kind: "none" };
    if (row.billing_state === "conservative") {
      return { kind: "conservatively-settled" };
    }
    if (
      !row.hosted_reservation_id ||
      row.reservation_operation !== "review" ||
      row.reservation_status !== "active" ||
      !row.reservation_expires_at ||
      row.reservation_expires_at <= now
    ) {
      return { kind: "none" };
    }
    const sourceReviewId = Number(row.current_review_id);
    const sourceReview = (
      await tx
        .select({ status: schema.reviews.status })
        .from(schema.reviews)
        .where(eq(schema.reviews.id, sourceReviewId))
        .limit(1)
    )[0];
    if (!sourceReview || !["failed", "stale"].includes(sourceReview.status)) {
      return { kind: "none" };
    }
    const transferred = await tx
      .update(schema.hostedUsageReservations)
      .set({
        reviewId: currentReviewId,
        expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.hostedUsageReservations.id, row.hosted_reservation_id),
          eq(schema.hostedUsageReservations.status, "active"),
          eq(schema.hostedUsageReservations.reviewId, sourceReviewId),
          gt(schema.hostedUsageReservations.expiresAt, now),
        ),
      )
      .returning({ id: schema.hostedUsageReservations.id });
    if (transferred.length !== 1) return { kind: "none" };
    const rebound = await tx
      .update(schema.largeReviewRuns)
      .set({ currentReviewId, expiresAt: new Date(now.getTime() + RUN_TTL_MS) })
      .where(
        and(
          eq(schema.largeReviewRuns.runKey, row.run_key),
          eq(schema.largeReviewRuns.currentReviewId, sourceReviewId),
          eq(
            schema.largeReviewRuns.hostedReservationId,
            row.hosted_reservation_id,
          ),
          eq(schema.largeReviewRuns.billingState, "active"),
        ),
      )
      .returning({ runKey: schema.largeReviewRuns.runKey });
    if (rebound.length !== 1) {
      throw new Error(
        "large-review run reservation ownership changed during transfer",
      );
    }
    return {
      kind: "resume",
      reservationId: transferred[0]!.id,
      expectedRunKey: row.run_key,
    };
  });
}

function responseHeaders(headers: Headers): Record<string, string> {
  const retained = new Set([
    "content-type",
    "retry-after",
    "x-request-id",
    "x-openrouter-request-id",
  ]);
  return Object.fromEntries(
    [...headers.entries()].filter(([name]) => retained.has(name.toLowerCase())),
  );
}

function requestHeaders(headers: Headers, additionalAuthHeader?: string): Headers {
  const retained = new Set([
    "authorization",
    "content-type",
    "http-referer",
    "x-api-key",
    "x-title",
    "anthropic-version",
  ]);
  if (additionalAuthHeader) retained.add(additionalAuthHeader.toLowerCase());
  return new Headers(
    [...headers.entries()].filter(([name]) => retained.has(name.toLowerCase())),
  );
}

export function canonicalOpenRouterRequestHeaders(
  headers: Headers,
  additionalAuthHeader?: string,
): Headers {
  const forwarded = requestHeaders(headers, additionalAuthHeader);
  forwarded.set("x-openrouter-metadata", "enabled");
  return forwarded;
}

function isCanonicalOpenRouterApiBase(rawBase: string): boolean {
  try {
    const url = new URL(rawBase);
    return (
      url.protocol === "https:" &&
      url.hostname === "openrouter.ai" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.replace(/\/+$/, "") === "/api/v1"
    );
  } catch {
    return false;
  }
}

function safeProviderLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (
    label.length === 0 ||
    label.length > 80 ||
    !SAFE_PROVIDER_LABEL.test(label) ||
    URL_LIKE_PROVIDER_LABEL.test(label) ||
    TOKEN_LIKE_PROVIDER_LABELS.some((pattern) => pattern.test(label))
  ) {
    return null;
  }
  return label;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function inspectOpenRouterFailure(input: {
  isCanonicalOpenRouter: boolean;
  status: number;
  body: string;
}): OpenRouterFailureInspection {
  if (!input.isCanonicalOpenRouter || !OPENROUTER_FAILURE_STATUSES.has(input.status)) {
    return { body: input.body, attempts: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return { body: input.body, attempts: [] };
  }
  const envelope = recordValue(parsed);
  if (!envelope) return { body: input.body, attempts: [] };

  const metadata = recordValue(envelope.openrouter_metadata);
  const attempts: OpenRouterProviderAttempt[] = [];
  if (Array.isArray(metadata?.attempts)) {
    for (const [index, candidate] of metadata.attempts
      .slice(0, MAX_OPENROUTER_ATTEMPTS)
      .entries()) {
      const attempt = recordValue(candidate);
      const provider = safeProviderLabel(attempt?.provider);
      const status = attempt?.status;
      if (
        provider &&
        typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
      ) {
        attempts.push({ ordinal: index + 1, provider, status });
      }
    }
  }

  const sanitizedEnvelope = { ...envelope };
  delete sanitizedEnvelope.openrouter_metadata;
  return { body: JSON.stringify(sanitizedEnvelope), attempts };
}

export function openRouterFailureDiagnostics(input: {
  isCanonicalOpenRouter: boolean;
  status: number;
  body: string;
  reviewId: number;
  requestSha256: string;
}): OpenRouterFailureInspection & { diagnostics: LargeReviewProviderDiagnostic[] } {
  const inspection = inspectOpenRouterFailure(input);
  return {
    ...inspection,
    diagnostics: inspection.attempts.map((attempt) => ({
      event: "postil.large_review.provider_failure",
      source: "upstream",
      review_id: input.reviewId,
      request_sha256: input.requestSha256,
      upstream_status: input.status,
      attempt_ordinal: attempt.ordinal,
      provider: attempt.provider,
      attempted_status: attempt.status,
    })),
  };
}

function providerRequestIdentity(bytes: Uint8Array): {
  requestSha256: string;
  batchIdentity: string;
  model: string;
} | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    if (!model || !Array.isArray(parsed.messages)) return null;
    return {
      requestSha256: sha256(bytes),
      batchIdentity: sha256(
        JSON.stringify({
          system: parsed.system ?? null,
          messages: parsed.messages,
        }),
      ),
      model,
    };
  } catch {
    return null;
  }
}

function hasReplayableAssistantContent(body: string, apiFormat: ApiFormat): boolean {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (apiFormat === "openai-compatible") {
      const choices = parsed.choices;
      if (!Array.isArray(choices)) return false;
      return choices.some((choice) => {
        if (!choice || typeof choice !== "object") return false;
        const message = (choice as Record<string, unknown>).message;
        return Boolean(
          message &&
            typeof message === "object" &&
            typeof (message as Record<string, unknown>).content === "string" &&
            ((message as Record<string, unknown>).content as string).length > 0,
        );
      });
    }
    return (
      Array.isArray(parsed.content) &&
      parsed.content.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).type === "text" &&
          typeof (entry as Record<string, unknown>).text === "string" &&
          ((entry as Record<string, unknown>).text as string).length > 0,
      )
    );
  } catch {
    return false;
  }
}

interface ProxyIdentitySeed {
  repositoryId: number;
  prNumber: number;
  cliVersion: string;
  configurationSha256: string;
  providerIdentity: string;
  headSha: string;
  baseSha: string;
  retryLineage: string;
}

export interface LargeReviewProviderProxy {
  apiBase: string;
  planEndpoint: string;
  planToken: string;
  redactionValues: readonly string[];
  close(): void;
  discardCompletedRun(): Promise<void>;
  billingOutcome(): "unused" | "resumable" | "ambiguous";
  boundRunKey(): Promise<string | null>;
}

interface PinnedUpstream {
  url: URL;
  hostname: string;
  addresses: Array<{ address: string; family: number }>;
}

interface FamilySelectingRequestOptions extends http.RequestOptions {
  servername?: string;
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
}

type ResolveAllAddresses = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

async function resolvePinnedUpstream(
  rawBase: string,
  endpoint: string,
  allowPrivate: boolean,
  resolveHostname: ResolveAllAddresses = lookup,
): Promise<PinnedUpstream> {
  const url = new URL(rawBase);
  if (url.username || url.password || url.hash) {
    throw new Error("provider API base must not contain credentials or a fragment");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("provider API base must use HTTP or HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${endpoint}`;
  const hostname = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolveHostname(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("provider API hostname resolved to no addresses");
  }
  if (addresses.some((entry) => isIP(entry.address) !== entry.family)) {
    throw new Error("provider API hostname resolved to an invalid address");
  }
  const privateResults = addresses.map((entry) =>
    isPrivateIpLiteral(entry.address),
  );
  if (
    url.protocol === "http:" &&
    (!allowPrivate || privateResults.some((value) => !value))
  ) {
    throw new Error(
      "plain HTTP provider APIs require an explicitly allowed private endpoint",
    );
  }
  if (!allowPrivate && privateResults.some(Boolean)) {
    throw new Error("provider API hostname resolved to a non-public address");
  }
  return {
    url,
    hostname,
    addresses,
  };
}

function forwardPinnedRequest(input: {
  upstream: PinnedUpstream;
  headers: Headers;
  body: Uint8Array;
  signal: AbortSignal;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = input.upstream.url.protocol === "https:" ? https : http;
    const requestOptions: FamilySelectingRequestOptions = {
      method: "POST",
      headers: Object.fromEntries(input.headers.entries()),
      signal: input.signal,
      servername: isIP(input.upstream.hostname)
        ? ""
        : input.upstream.hostname,
      autoSelectFamily: input.upstream.addresses.length > 1,
      autoSelectFamilyAttemptTimeout: 250,
      lookup: (_hostname, options, callback) => {
        const all = typeof options === "object" && options.all;
        if (all) {
          callback(
            null,
            input.upstream.addresses.map(({ address, family }) => ({
              address,
              family,
            })),
          );
        } else {
          const first = input.upstream.addresses[0]!;
          callback(null, first.address, first.family);
        }
      },
    };
    const request = transport.request(
      input.upstream.url,
      requestOptions,
      (response) => {
        if (response.headers["content-encoding"]) {
          response.destroy();
          reject(new Error("compressed provider responses are not accepted"));
          return;
        }
        const declared = Number(response.headers["content-length"] ?? "0");
        if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
          response.destroy();
          reject(new Error("provider response too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_PROVIDER_RESPONSE_BYTES) {
            response.destroy(new Error("provider response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("aborted", () =>
          reject(new Error("provider response aborted")),
        );
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) headers.set(name, value.join(", "));
            else if (value !== undefined) headers.set(name, value);
          }
          resolve(
            new Response(Buffer.concat(chunks, total), {
              status: response.statusCode ?? 502,
              headers: responseHeaders(headers),
            }),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(input.body);
  });
}

const PLAN_KEYS = [
  "version",
  "planSha256",
  "directHunks",
  "semanticHunks",
  "unreviewedHunks",
  "selectedBatches",
  "totalBatches",
  "concurrency",
  "requestTimeoutSeconds",
  "reviewBudgetSeconds",
] as const;

function parsePlanRegistration(
  value: unknown,
): Record<(typeof PLAN_KEYS)[number], number | string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
    [...PLAN_KEYS].sort().join("\0")
  ) {
    return null;
  }
  if (record.version !== PLAN_REGISTRATION_VERSION) return null;
  if (
    typeof record.planSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.planSha256)
  ) {
    return null;
  }
  for (const key of PLAN_KEYS.slice(2)) {
    const number = record[key];
    if (!Number.isSafeInteger(number) || (number as number) < 0) return null;
  }
  if (
    (record.selectedBatches as number) > (record.totalBatches as number) ||
    (record.concurrency as number) < 1 ||
    (record.requestTimeoutSeconds as number) < 1 ||
    (record.reviewBudgetSeconds as number) < 1
  ) {
    return null;
  }
  return record as Record<(typeof PLAN_KEYS)[number], number | string>;
}

function bearerMatches(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function startLargeReviewProviderProxy(input: {
  upstreamApiBase: string;
  apiFormat: ApiFormat;
  additionalAuthHeader?: string;
  allowPrivateUpstream?: boolean;
  resolveHostname?: ResolveAllAddresses;
  identity: ProxyIdentitySeed;
  runContext: LargeReviewRunContext;
  store: LargeReviewAttemptStore;
  operatorLog?: (diagnostic: LargeReviewProviderDiagnostic) => void;
}): Promise<LargeReviewProviderProxy> {
  const token = randomUUID();
  const planToken = randomUUID();
  const expectedEndpoint =
    input.apiFormat === "openai-compatible" ? "chat/completions" : "messages";
  const upstream = await resolvePinnedUpstream(
    input.upstreamApiBase,
    expectedEndpoint,
    input.allowPrivateUpstream ?? false,
    input.resolveHostname,
  );
  let runKey: string | undefined;
  let bindPromise: Promise<void> | undefined;
  let registeredPlan: string | undefined;
  let cachedResponses = 0;
  let ambiguousProviderContact = false;
  const attempts = new Map<string, number>();
  const operatorLog = input.operatorLog ?? ((diagnostic) => {
    console.warn(JSON.stringify(diagnostic));
  });
  const emitDiagnostic = (diagnostic: LargeReviewProviderDiagnostic): void => {
    try {
      operatorLog(diagnostic);
    } catch {
      // Operator diagnostics must never alter provider failure handling.
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      const url = new URL(request.url);
      if (url.pathname === `/${token}/large-review-plan`) {
        if (!bearerMatches(request.headers.get("authorization"), planToken)) {
          return new Response("unauthorized", { status: 401 });
        }
        const declaredLength = Number(
          request.headers.get("content-length") ?? "0",
        );
        if (declaredLength > MAX_PLAN_REGISTRATION_BYTES) {
          return new Response("plan registration too large", { status: 413 });
        }
        let parsed: unknown;
        try {
          const bytes = await request.arrayBuffer();
          if (bytes.byteLength > MAX_PLAN_REGISTRATION_BYTES) {
            return new Response("plan registration too large", { status: 413 });
          }
          parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return new Response("invalid plan registration", { status: 400 });
        }
        const plan = parsePlanRegistration(parsed);
        if (!plan) {
          return new Response("invalid plan registration", { status: 400 });
        }
        const normalized = JSON.stringify(plan);
        if (registeredPlan && registeredPlan !== normalized) {
          return new Response("conflicting plan registration", { status: 409 });
        }
        registeredPlan = normalized;
        bindPromise ??= input.store
          .bindRun(
            { ...input.identity, planSha256: plan.planSha256 as string },
            input.runContext,
          )
          .then((boundRunKey) => {
            runKey = boundRunKey;
          });
        try {
          await bindPromise;
        } catch {
          return new Response("plan registration failed", { status: 409 });
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname !== `/${token}/${expectedEndpoint}`) {
        return new Response("not found", { status: 404 });
      }
      if (!bindPromise) {
        return new Response("provider plan is not registered", { status: 428 });
      }
      try {
        await bindPromise;
      } catch {
        return new Response("provider plan registration failed", { status: 409 });
      }
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_PROVIDER_REQUEST_BYTES) {
        return new Response("request too large", { status: 413 });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_PROVIDER_REQUEST_BYTES) {
        return new Response("request too large", { status: 413 });
      }

      const canonicalOpenRouter = isCanonicalOpenRouterApiBase(
        input.upstreamApiBase,
      );
      const headers = canonicalOpenRouter
        ? canonicalOpenRouterRequestHeaders(
            request.headers,
            input.additionalAuthHeader,
          )
        : requestHeaders(request.headers, input.additionalAuthHeader);
      const forward = async (): Promise<{
        response: Response;
        source: "upstream" | "gateway";
      }> => {
        try {
          return {
            response: await forwardPinnedRequest({
              upstream,
              headers,
              body: bytes,
              signal: request.signal,
            }),
            source: "upstream",
          };
        } catch {
          ambiguousProviderContact = true;
          return {
            response: new Response("provider request failed", { status: 502 }),
            source: "gateway",
          };
        }
      };
      if (!runKey) return new Response("provider plan is not bound", { status: 409 });

      const requestIdentity = providerRequestIdentity(bytes);
      if (!requestIdentity) {
        return new Response("invalid provider request", { status: 400 });
      }
      const { requestSha256, batchIdentity, model } = requestIdentity;
      const attempt = (attempts.get(requestSha256) ?? 0) + 1;
      attempts.set(requestSha256, attempt);
      const attemptInput = { runKey, requestSha256, batchIdentity, attempt, model };
      const claim = await input.store.claimAttempt(attemptInput);
      if (claim.kind === "replay") {
        cachedResponses += 1;
        return new Response(claim.response.body, {
          status: claim.response.status,
          headers: claim.response.headers,
        });
      }
      if (claim.kind === "pending") {
        emitDiagnostic({
          event: "postil.large_review.provider_failure",
          source: "gateway",
          review_id: input.runContext.currentReviewId,
          request_sha256: requestSha256,
          gateway_status: 503,
          request_attempt: attempt,
        });
        return new Response("provider attempt is already in progress", {
          status: 503,
          headers: { "retry-after": "1" },
        });
      }

      const forwarded = await forward();
      const response = forwarded.response;
      const body = await response.text();
      if (forwarded.source === "gateway") {
        emitDiagnostic({
          event: "postil.large_review.provider_failure",
          source: "gateway",
          review_id: input.runContext.currentReviewId,
          request_sha256: requestSha256,
          gateway_status: response.status,
          request_attempt: attempt,
        });
      }
      const inspection = openRouterFailureDiagnostics({
        isCanonicalOpenRouter: forwarded.source === "upstream" && canonicalOpenRouter,
        status: response.status,
        body,
        reviewId: input.runContext.currentReviewId,
        requestSha256,
      });
      for (const diagnostic of inspection.diagnostics) emitDiagnostic(diagnostic);
      const storedResponse = {
        status: response.status,
        headers: responseHeaders(response.headers),
        body: inspection.body,
      };
      if (
        response.ok &&
        hasReplayableAssistantContent(body, input.apiFormat)
      ) {
        try {
          await input.store.completeAttempt({
            attemptKey: claim.attemptKey,
            leaseId: claim.leaseId,
            response: storedResponse,
          });
          cachedResponses += 1;
        } catch {
          ambiguousProviderContact = true;
          emitDiagnostic({
            event: "postil.large_review.provider_failure",
            source: "gateway",
            review_id: input.runContext.currentReviewId,
            request_sha256: requestSha256,
            gateway_status: 503,
            request_attempt: attempt,
          });
          return new Response("provider response could not be persisted", {
            status: 503,
          });
        }
      } else {
        await input.store.abandonAttempt(claim.attemptKey, claim.leaseId);
        if (response.ok) ambiguousProviderContact = true;
      }
      return new Response(inspection.body, {
        status: response.status,
        headers: storedResponse.headers,
      });
    },
  });

  const apiBase = `http://127.0.0.1:${server.port}/${token}`;
  const planEndpoint = `${apiBase}/large-review-plan`;
  return {
    apiBase,
    planEndpoint,
    planToken,
    redactionValues: [token, planToken, apiBase, planEndpoint],
    close() {
      server.stop(true);
    },
    async discardCompletedRun() {
      if (bindPromise) await bindPromise;
      if (runKey) await input.store.deleteRun(runKey);
    },
    billingOutcome() {
      if (ambiguousProviderContact) return "ambiguous";
      if (cachedResponses > 0) return "resumable";
      return "unused";
    },
    async boundRunKey() {
      if (bindPromise) await bindPromise;
      return runKey ?? null;
    },
  };
}
