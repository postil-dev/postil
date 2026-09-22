import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import { z } from "zod";

import { getDb, getPool } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { verifyLiveGithubAdmin } from "@/lib/github/approval-actor";
import { getPullRequestReviewContext } from "@/lib/github/checks";
import { isGratitudeOnly, isPostilBotLogin } from "@/lib/github/conversation";
import { readGitHubReviewFeedback, type ReviewFeedbackActor } from "@/lib/github/publication-threads";
import { parsePostilApproveCommand, parsePostilDismissCommand, isPostilReviewCommand } from "@/lib/mentions";
import { canProcessRepositoryInference } from "@/lib/private-repository-entitlement";
import { enqueueReviewJobOnce, type ReviewJobPayload } from "@/lib/queue";
import { redactAndTruncate } from "@/lib/redact";

export const REVIEW_FEEDBACK_JOB_KIND = "review-feedback-reconciliation";
export const REVIEW_FEEDBACK_MAX_BYTES = 32 * 1024;
const POLL_INTERVAL_MS = 5 * 60_000;

export interface ReviewFeedbackContext {
  version: 1;
  repository: string;
  prNumber: number;
  headSha: string;
  threads: Array<{
    findingId: string;
    rootCommentId: number;
    resolved: boolean;
    comments: Array<{
      commentId: number;
      author: ReviewFeedbackActor;
      body: string;
      updatedAt: string;
    }>;
  }>;
}

const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedText = (maximum: number) => z.string().refine((value) => Buffer.byteLength(value) <= maximum);
const feedbackSchema = z.object({
  version: z.literal(1),
  repository: boundedText(256).refine((value) => /^[\w.-]+\/[\w.-]+$/.test(value)),
  prNumber: safeId,
  headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  threads: z.array(z.object({
    findingId: boundedText(128).refine((value) => value.trim().length > 0),
    rootCommentId: safeId,
    resolved: z.boolean(),
    comments: z.array(z.object({
      commentId: safeId,
      author: z.object({ id: safeId, login: boundedText(100).refine((value) => value.trim().length > 0) }).strict(),
      body: boundedText(4 * 1024),
      updatedAt: z.iso.datetime().max(64)
        .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/),
    }).strict()).max(20),
  }).strict()).max(20),
}).strict();

interface FeedbackRepository {
  repositoryId: number;
  githubRepoId: number;
  fullName: string;
  private: boolean;
  installationId: number;
  sourceInstallationId: number;
  orgId: number;
  installationAccountType: string;
}

export interface ReviewFeedbackJobPayload extends Record<string, unknown> {
  githubRepoId: number;
  prNumber: number;
  installationId: number;
}

/** Activate only after every review consumer supports the feedback file contract. */
export function reviewFeedbackEnabled(): boolean {
  return process.env.POSTIL_REVIEW_FEEDBACK_ENABLED === "1";
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Validate and serialize exact feedback bytes shared by hashing and CLI input. */
export function serializeReviewFeedback(context: ReviewFeedbackContext): string {
  if (!feedbackSchema.safeParse(context).success) throw new Error("review feedback context identity or bounds are invalid");
  const roots = new Set<number>();
  const comments = new Set<number>();
  for (const thread of context.threads) {
    if (!positiveId(thread.rootCommentId) || roots.has(thread.rootCommentId) ||
        typeof thread.findingId !== "string" || !thread.findingId.trim() || Buffer.byteLength(thread.findingId) > 128 ||
        typeof thread.resolved !== "boolean" || !Array.isArray(thread.comments) || thread.comments.length > 20) {
      throw new Error("review feedback thread identity is invalid");
    }
    roots.add(thread.rootCommentId);
    for (const comment of thread.comments) {
      if (!positiveId(comment.commentId) || comments.has(comment.commentId) ||
          !positiveId(comment.author?.id) || typeof comment.author.login !== "string" ||
          !comment.author.login || comment.author.login.length > 100 ||
          typeof comment.body !== "string" || typeof comment.updatedAt !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(comment.updatedAt) ||
          !Number.isFinite(Date.parse(comment.updatedAt))) {
        throw new Error("review feedback reply identity is invalid");
      }
      comments.add(comment.commentId);
    }
  }
  if (comments.size > 128) throw new Error("review feedback exceeds 128 comments");
  const bytes = JSON.stringify(context);
  if (Buffer.byteLength(bytes) > REVIEW_FEEDBACK_MAX_BYTES) throw new Error("review feedback exceeds 32 KiB");
  return bytes;
}

export function reviewFeedbackDigest(context: ReviewFeedbackContext): string {
  return createHash("sha256").update(serializeReviewFeedback(context)).digest("hex");
}

/** Include this file's relative path in hashEffectiveReviewConfiguration before run lookup. */
export async function writeReviewFeedbackFile(
  path: string,
  payload: Pick<ReviewJobPayload, "reviewFeedback" | "repoFullName" | "prNumber" | "headSha">,
): Promise<boolean> {
  const context = payload.reviewFeedback;
  if (!context) return false;
  if (context.repository !== payload.repoFullName || context.prNumber !== payload.prNumber ||
      context.headSha !== payload.headSha) throw new Error("review feedback does not match the review snapshot");
  await writeFile(path, serializeReviewFeedback(context), { mode: 0o600 });
  return true;
}

async function loadFeedbackRepository(pool: Pick<Pool, "query">, payload: ReviewFeedbackJobPayload): Promise<FeedbackRepository | null> {
  if (!positiveId(payload.githubRepoId) || !positiveId(payload.prNumber) || !positiveId(payload.installationId)) {
    throw new Error("review feedback reconciliation job payload is malformed");
  }
  const result = await pool.query<FeedbackRepository>(`
    SELECT repository.id AS "repositoryId", repository.github_repo_id AS "githubRepoId",
           repository.full_name AS "fullName", repository.private,
           installation.id AS "sourceInstallationId", installation.github_installation_id AS "installationId",
           installation.org_id AS "orgId", installation.account_type AS "installationAccountType"
      FROM repositories repository
      JOIN installations installation ON installation.id = repository.installation_id
     WHERE repository.github_repo_id = $1 AND installation.github_installation_id = $2
       AND repository.enabled AND NOT installation.suspended AND installation.org_id IS NOT NULL
     LIMIT 1`, [payload.githubRepoId, payload.installationId]);
  const row = result.rows[0];
  if (!row) return null;
  const normalized = { ...row, repositoryId: Number(row.repositoryId), githubRepoId: Number(row.githubRepoId),
    installationId: Number(row.installationId), sourceInstallationId: Number(row.sourceInstallationId), orgId: Number(row.orgId) };
  if (![normalized.repositoryId, normalized.githubRepoId, normalized.installationId,
    normalized.sourceInstallationId, normalized.orgId].every(positiveId)) {
    throw new Error("review feedback repository identity is invalid");
  }
  return normalized;
}

/** Webhooks wake a verified root; replies and resolution flags grant no disposition. */
export async function admitReviewFeedbackEvent(input: ReviewFeedbackJobPayload & {
  actor: { id?: number; login?: string; type?: string };
  rootCommentId: number;
}, pool: Pool = getPool()): Promise<boolean> {
  if (!reviewFeedbackEnabled() || !positiveId(input.actor?.id) || !input.actor.login ||
      input.actor.type === "Bot" || input.actor.login.endsWith("[bot]") ||
      isPostilBotLogin(input.actor.login) || !positiveId(input.rootCommentId)) return false;
  const repository = await loadFeedbackRepository(pool, input);
  if (!repository) return false;
  const publication = await pool.query(`
    SELECT 1 FROM finding_publications publication
    JOIN reviews review ON review.id = publication.review_id
    WHERE review.repository_id = $1 AND review.pr_number = $2
      AND review.source_github_installation_id = $3 AND review.source_github_repo_id = $4
      AND publication.github_comment_id = $5 LIMIT 1`,
  [repository.repositoryId, input.prNumber, input.installationId, input.githubRepoId, String(input.rootCommentId)]);
  if (!publication.rowCount) return false;
  const signal = AbortSignal.timeout(15_000);
  const token = await getInstallationToken(input.installationId, signal);
  const verification = await verifyLiveGithubAdmin(repository, input.actor, repository.fullName, token, signal);
  if (verification.outcome === "unavailable") throw new Error("review feedback actor authority is unavailable");
  if (verification.outcome !== "authorized") return false;
  return enqueueReviewFeedbackJob(pool, {
    githubRepoId: input.githubRepoId, installationId: input.installationId, prNumber: input.prNumber,
  });
}

async function enqueueReviewFeedbackJob(pool: Pool, payload: ReviewFeedbackJobPayload): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:feedback-poll:${payload.githubRepoId}:${payload.prNumber}`,
    ]);
    const result = await client.query(`
      INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
      SELECT $1, $2::jsonb, 'queued', now() + interval '10 seconds', 5
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = $1 AND status IN ('queued', 'running')
                           AND payload->>'githubRepoId' = $3 AND payload->>'prNumber' = $4)
      RETURNING id`, [REVIEW_FEEDBACK_JOB_KIND, JSON.stringify(payload), String(payload.githubRepoId), String(payload.prNumber)]);
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Bound each watchdog pass to twenty due pull requests, independent of webhook subscriptions. */
export async function scheduleReviewFeedbackReconciliationJobs(pool: Pool, now = new Date()): Promise<number> {
  if (!reviewFeedbackEnabled()) return 0;
  const result = await pool.query<ReviewFeedbackJobPayload>(`
    WITH candidates AS MATERIALIZED (
      SELECT DISTINCT ON (review.repository_id, review.pr_number)
             review.repository_id, review.pr_number, repository.github_repo_id,
             installation.github_installation_id,
             COALESCE(poll.next_poll_at, review.finished_at, review.queued_at) AS due_at
        FROM reviews review
        JOIN repositories repository ON repository.id = review.repository_id
        JOIN installations installation ON installation.id = repository.installation_id
        LEFT JOIN review_feedback_polls poll
          ON poll.github_repo_id = repository.github_repo_id AND poll.pr_number = review.pr_number
       WHERE review.queued_at >= $1::timestamptz - interval '30 days'
         AND repository.enabled AND NOT installation.suspended AND installation.org_id IS NOT NULL
         AND review.source_github_installation_id = installation.github_installation_id
         AND EXISTS (SELECT 1 FROM finding_publications publication
                       WHERE publication.review_id = review.id AND publication.github_comment_id IS NOT NULL)
         AND (poll.next_poll_at IS NULL OR poll.next_poll_at <= $1::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind = $2 AND status IN ('queued', 'running')
                           AND payload->>'githubRepoId' = repository.github_repo_id::text
                           AND payload->>'prNumber' = review.pr_number::text)
       ORDER BY review.repository_id, review.pr_number, review.queued_at DESC
    )
    SELECT github_repo_id AS "githubRepoId", pr_number AS "prNumber", github_installation_id AS "installationId"
      FROM candidates ORDER BY due_at, repository_id, pr_number LIMIT 20
    `, [now, REVIEW_FEEDBACK_JOB_KIND]);
  let scheduled = 0;
  for (const row of result.rows) {
    if (await enqueueReviewFeedbackJob(pool, {
      githubRepoId: Number(row.githubRepoId), prNumber: Number(row.prNumber), installationId: Number(row.installationId),
    })) scheduled += 1;
  }
  return scheduled;
}

/** Poll live human evidence, then use the existing review queue and publication pipeline. */
export async function reconcileReviewFeedback(
  payload: ReviewFeedbackJobPayload,
  pool: Pool = getPool(),
): Promise<void> {
  if (!reviewFeedbackEnabled()) return;
  const repository = await loadFeedbackRepository(pool, payload);
  if (!repository) return;
  let nextPollAt = new Date(Date.now() + POLL_INTERVAL_MS);
  let lastError: string | null = null;
  try {
    const allowed = await canProcessRepositoryInference(getDb(), {
      orgId: repository.orgId, repositoryPrivate: repository.private,
    });
    if (!allowed.allowed) return;
    const publications = await pool.query<{ githubCommentId: string; findingId: string }>(`
      SELECT DISTINCT ON (publication.github_comment_id)
             publication.github_comment_id AS "githubCommentId", publication.finding_id AS "findingId"
        FROM finding_publications publication JOIN reviews review ON review.id = publication.review_id
       WHERE review.repository_id = $1 AND review.pr_number = $2
         AND review.source_github_installation_id = $3 AND review.source_github_repo_id = $4
         AND publication.github_comment_id IS NOT NULL
       ORDER BY publication.github_comment_id, review.id ASC LIMIT 101`,
    [repository.repositoryId, payload.prNumber, payload.installationId, payload.githubRepoId]);
    if (publications.rows.length > 100) throw new Error("review feedback exceeds 100 stored publications");
    if (publications.rows.length === 0) return;
    const roots = new Map(publications.rows.map((row) => [Number(row.githubCommentId), row.findingId]));
    const signal = AbortSignal.timeout(45_000);
    const token = await getInstallationToken(payload.installationId, signal);
    const observed = await readGitHubReviewFeedback(token, { id: repository.githubRepoId, fullName: repository.fullName },
      payload.prNumber, new Set(roots.keys()), signal);
    if (!observed.open) {
      nextPollAt = new Date(Date.now() + 24 * 60 * 60_000);
      return;
    }
    const authority = new Map<number, { login: string; authorized: boolean }>();
    async function authorized(actor: ReviewFeedbackActor | null): Promise<boolean> {
      if (!actor) return false;
      const cached = authority.get(actor.id);
      if (cached?.login === actor.login) return cached.authorized;
      if (authority.size >= 20) throw new Error("review feedback exceeds 20 human actors");
      const result = await verifyLiveGithubAdmin(repository!, actor, repository!.fullName, token, signal);
      if (result.outcome === "unavailable") throw new Error("review feedback actor authority is unavailable");
      const value = result.outcome === "authorized";
      authority.set(actor.id, { login: actor.login, authorized: value });
      return value;
    }
    const threads: ReviewFeedbackContext["threads"] = [];
    for (const thread of observed.threads) {
      const comments: ReviewFeedbackContext["threads"][number]["comments"] = [];
      for (const comment of thread.comments) {
        if (isGratitudeOnly(comment.body) || parsePostilApproveCommand(comment.body) ||
            parsePostilDismissCommand(comment.body) || isPostilReviewCommand(comment.body)) continue;
        if (await authorized(comment.author)) comments.push(comment);
      }
      const humanResolution = thread.resolved && await authorized(thread.resolvedBy);
      if (comments.length === 0 && !humanResolution) continue;
      threads.push({ findingId: roots.get(thread.rootCommentId)!, rootCommentId: thread.rootCommentId,
        resolved: humanResolution, comments: comments.sort((left, right) => left.commentId - right.commentId) });
    }
    if (threads.length === 0) return;
    const reviewFeedback: ReviewFeedbackContext = {
      version: 1, repository: repository.fullName, prNumber: payload.prNumber,
      headSha: observed.headSha, threads: threads.sort((left, right) => left.rootCommentId - right.rootCommentId),
    };
    const digest = reviewFeedbackDigest(reviewFeedback);
    const live = await getPullRequestReviewContext(token, repository.fullName, payload.prNumber, signal);
    signal.throwIfAborted();
    if (!live.open || live.merged || live.draft || live.headSha !== observed.headSha) return;
    await enqueueReviewJobOnce(pool, {
      installationId: payload.installationId, sourceInstallationId: repository.sourceInstallationId,
      sourceOrgId: repository.orgId, githubRepoId: repository.githubRepoId, repoFullName: repository.fullName,
      repositoryPrivate: repository.private, prNumber: payload.prNumber,
      authorGithubId: live.authorGithubId, authorLogin: live.authorLogin,
      headSha: live.headSha, baseSha: live.baseSha, forceFullReview: true, reviewFeedback,
      trigger: { source: "finding_feedback", feedbackDigest: digest },
    });
  } catch (error) {
    lastError = redactAndTruncate(error, 1_000);
    nextPollAt = new Date(Date.now() + 30 * 60_000);
    throw error;
  } finally {
    await pool.query(`
      INSERT INTO review_feedback_polls (github_repo_id, pr_number, next_poll_at, last_error)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (github_repo_id, pr_number) DO UPDATE
        SET next_poll_at = EXCLUDED.next_poll_at, last_error = EXCLUDED.last_error`,
    [payload.githubRepoId, payload.prNumber, nextPollAt, lastError]);
  }
}
