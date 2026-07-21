import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import type { ApiFormat } from "@/lib/byok-provider";
import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { HOSTED_REVIEW_RESERVATION_TTL_MS } from "@/lib/hosted-usage-reservations";

const RUN_TTL_MS = 24 * 60 * 60 * 1_000;
const ATTEMPT_LEASE_MS = 8 * 60 * 1_000;
const MAX_PROVIDER_REQUEST_BYTES = 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const LARGE_REVIEW_PLAN_LINE =
  /^postil: deterministic large-review plan=([0-9a-f]{64})(?:\s|$)/;
const PROVIDER_ATTEMPT_LINE = /^postil: llm attempt\s/;

export interface LargeReviewRunIdentity {
  repositoryId: number;
  cliVersion: string;
  configurationSha256: string;
  providerIdentity: string;
  headSha: string;
  planSha256: string;
}

export interface LargeReviewRunContext {
  currentReviewId: number;
  hostedReservationId: string | null;
}

export interface StoredProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

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
    identity.cliVersion,
    identity.configurationSha256,
    identity.providerIdentity,
    identity.headSha,
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
}): string {
  const url = new URL(input.apiBase);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return JSON.stringify([
    input.byok ? "byok" : "managed",
    input.apiFormat,
    url.toString(),
  ]);
}

export class PostgresLargeReviewAttemptStore implements LargeReviewAttemptStore {
  constructor(private readonly db: Database) {}

  async bindRun(
    identity: LargeReviewRunIdentity,
    context: LargeReviewRunContext,
  ): Promise<string> {
    const now = new Date();
    const runKey = largeReviewRunKey(identity);
    await this.db
      .delete(schema.largeReviewRuns)
      .where(lte(schema.largeReviewRuns.expiresAt, now));
    await this.db
      .insert(schema.largeReviewRuns)
      .values({
        runKey,
        ...identity,
        ...context,
        expiresAt: new Date(now.getTime() + RUN_TTL_MS),
      })
      .onConflictDoNothing();
    const stored = (
      await this.db
        .select()
        .from(schema.largeReviewRuns)
        .where(eq(schema.largeReviewRuns.runKey, runKey))
        .limit(1)
    )[0];
    if (
      !stored ||
      stored.repositoryId !== identity.repositoryId ||
      stored.cliVersion !== identity.cliVersion ||
      stored.configurationSha256 !== identity.configurationSha256 ||
      stored.providerIdentity !== identity.providerIdentity ||
      stored.headSha !== identity.headSha ||
      stored.planSha256 !== identity.planSha256
    ) {
      throw new Error("large-review run identity collision");
    }
    await this.db
      .update(schema.largeReviewRuns)
      .set({
        currentReviewId: context.currentReviewId,
        hostedReservationId: context.hostedReservationId,
        expiresAt: new Date(now.getTime() + RUN_TTL_MS),
      })
      .where(eq(schema.largeReviewRuns.runKey, runKey));
    return runKey;
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

export async function claimReusableLargeReviewReservation(
  db: Database,
  identity: Omit<LargeReviewRunIdentity, "planSha256">,
  currentReviewId: number,
): Promise<string | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + HOSTED_REVIEW_RESERVATION_TTL_MS);
  return db.transaction(async (tx) => {
    const selected = await tx.execute(sql`
      SELECT run.run_key, run.hosted_reservation_id
        FROM large_review_runs run
        JOIN hosted_usage_reservations reservation
          ON reservation.id = run.hosted_reservation_id
       WHERE run.repository_id = ${identity.repositoryId}
         AND run.cli_version = ${identity.cliVersion}
         AND run.configuration_sha256 = ${identity.configurationSha256}
         AND run.provider_identity = ${identity.providerIdentity}
         AND run.head_sha = ${identity.headSha}
         AND run.expires_at > ${now}
         AND reservation.operation = 'review'
         AND reservation.status = 'active'
         AND reservation.expires_at > ${now}
       ORDER BY run.created_at DESC
       FOR UPDATE OF run, reservation
       LIMIT 1
    `);
    const row = selected.rows[0] as
      | { run_key: string; hosted_reservation_id: string }
      | undefined;
    if (!row) return null;
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
          gt(schema.hostedUsageReservations.expiresAt, now),
        ),
      )
      .returning({ id: schema.hostedUsageReservations.id });
    if (transferred.length !== 1) return null;
    await tx
      .update(schema.largeReviewRuns)
      .set({ currentReviewId, expiresAt: new Date(now.getTime() + RUN_TTL_MS) })
      .where(eq(schema.largeReviewRuns.runKey, row.run_key));
    return transferred[0]!.id;
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
    "x-openrouter-experimental-metadata",
  ]);
  if (additionalAuthHeader) retained.add(additionalAuthHeader.toLowerCase());
  return new Headers(
    [...headers.entries()].filter(([name]) => retained.has(name.toLowerCase())),
  );
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
  cliVersion: string;
  configurationSha256: string;
  providerIdentity: string;
  headSha: string;
}

export interface LargeReviewProviderProxy {
  apiBase: string;
  observeCliStderr(line: string): void;
  close(): void;
  discardCompletedRun(): Promise<void>;
  billingCanResumeExactly(): boolean;
}

export function startLargeReviewProviderProxy(input: {
  upstreamApiBase: string;
  apiFormat: ApiFormat;
  additionalAuthHeader?: string;
  identity: ProxyIdentitySeed;
  runContext: LargeReviewRunContext;
  store: LargeReviewAttemptStore;
}): LargeReviewProviderProxy {
  const token = randomUUID();
  const upstreamBase = input.upstreamApiBase.replace(/\/+$/, "");
  const expectedEndpoint =
    input.apiFormat === "openai-compatible" ? "chat/completions" : "messages";
  let runKey: string | undefined;
  let decisionMade = false;
  let resolveDecision: (() => void) | undefined;
  const decision = new Promise<void>((resolve) => {
    resolveDecision = resolve;
  });
  let bindPromise: Promise<void> | undefined;
  let cachedResponses = 0;
  let ambiguousProviderContact = false;
  const attempts = new Map<string, number>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      const url = new URL(request.url);
      if (url.pathname !== `/${token}/${expectedEndpoint}`) {
        return new Response("not found", { status: 404 });
      }
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_PROVIDER_REQUEST_BYTES) {
        return new Response("request too large", { status: 413 });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_PROVIDER_REQUEST_BYTES) {
        return new Response("request too large", { status: 413 });
      }

      await decision;
      if (bindPromise) await bindPromise;

      const headers = requestHeaders(request.headers, input.additionalAuthHeader);
      if (upstreamBase === "https://openrouter.ai/api/v1") {
        headers.set("x-openrouter-experimental-metadata", "enabled");
      }
      const forward = async (): Promise<Response> => {
        let response: Response;
        try {
          response = await fetch(`${upstreamBase}/${expectedEndpoint}`, {
            method: "POST",
            headers,
            body: bytes,
            redirect: "manual",
            signal: request.signal,
          });
        } catch {
          ambiguousProviderContact = true;
          return new Response("provider request failed", { status: 502 });
        }
        const responseBytes = new Uint8Array(await response.arrayBuffer());
        if (responseBytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
          ambiguousProviderContact = true;
          return new Response("provider response too large", { status: 502 });
        }
        return new Response(responseBytes, {
          status: response.status,
          headers: responseHeaders(response.headers),
        });
      };

      if (!runKey) return forward();

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
        return new Response("provider attempt is already in progress", {
          status: 503,
          headers: { "retry-after": "1" },
        });
      }

      const response = await forward();
      const body = await response.text();
      const storedResponse = {
        status: response.status,
        headers: responseHeaders(response.headers),
        body,
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
          return new Response("provider response could not be persisted", {
            status: 503,
          });
        }
      } else {
        await input.store.abandonAttempt(claim.attemptKey, claim.leaseId);
        if (response.ok) ambiguousProviderContact = true;
      }
      return new Response(body, {
        status: response.status,
        headers: storedResponse.headers,
      });
    },
  });

  const makeDecision = () => {
    if (decisionMade) return;
    decisionMade = true;
    resolveDecision?.();
  };

  return {
    apiBase: `http://127.0.0.1:${server.port}/${token}`,
    observeCliStderr(line) {
      const plan = LARGE_REVIEW_PLAN_LINE.exec(line)?.[1];
      if (plan && !bindPromise) {
        bindPromise = input.store
          .bindRun({ ...input.identity, planSha256: plan }, input.runContext)
          .then((boundRunKey) => {
            runKey = boundRunKey;
          });
        makeDecision();
        return;
      }
      if (PROVIDER_ATTEMPT_LINE.test(line)) makeDecision();
    },
    close() {
      makeDecision();
      server.stop(true);
    },
    async discardCompletedRun() {
      if (bindPromise) await bindPromise;
      if (runKey) await input.store.deleteRun(runKey);
    },
    billingCanResumeExactly() {
      return cachedResponses > 0 && !ambiguousProviderContact;
    },
  };
}
