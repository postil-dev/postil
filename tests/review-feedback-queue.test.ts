import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";

const describeDb = process.env.POSTIL_TEST_DATABASE_URL ? describe : describe.skip;
const originalFetch = globalThis.fetch;
const originalDatabase = process.env.DATABASE_URL;
const originalEnabled = process.env.POSTIL_REVIEW_FEEDBACK_ENABLED;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
let reply = "The documented deployment sequence includes a restore after initial installation.";
let updatedAt = "2026-09-01T12:00:00Z";
let authority: "authorized" | "denied" | "unavailable" = "authorized";
let rejectContextRead = false;
let contextSignal: AbortSignal | undefined;
const rootId = 4_000_000_010;
const realAuth = await import("@/lib/github/app-auth");
mock.module("@/lib/github/app-auth", () => ({ ...realAuth, getInstallationToken: async () => crypto.randomUUID() }));
const realActor = await import("@/lib/github/approval-actor");
mock.module("@/lib/github/approval-actor", () => ({ ...realActor,
  verifyLiveGithubAdmin: async (_review: unknown, actor: { id: number }) => ({ outcome: actor.id === 51 ? authority : "denied" }),
}));
const realChecks = await import("@/lib/github/checks");
mock.module("@/lib/github/checks", () => ({ ...realChecks,
  getPullRequestReviewContext: async (_token: string, _repository: string, _pr: number, signal?: AbortSignal) => {
    contextSignal = signal;
    if (rejectContextRead) throw new DOMException("context request aborted", "AbortError");
    return { open: true, merged: false, draft: false, headSha, baseSha,
      authorGithubId: 51, authorLogin: "maintainer" };
  },
}));
mock.module("@/lib/private-repository-entitlement", () => ({ canProcessRepositoryInference: async () => ({ allowed: true }) }));

const { admitReviewFeedbackEvent, reconcileReviewFeedback, scheduleReviewFeedbackReconciliationJobs } = await import("@/lib/review-feedback");
const { claimJob, enqueueReviewJobOnce, requeueJobsOwnedBy } = await import("@/lib/queue");
const { deferHostedReviewForRelease, activateHostedInferenceRelease } = await import("@/lib/release-job-rollout");
const { closeDb } = await import("@/lib/db");

describeDb("durable review feedback admission", () => {
  let database: EphemeralDatabase;
  let repositoryId: number;
  let orgId: number;
  let installationId: number;
  const identity = { githubRepoId: 71, installationId: 81, prNumber: 17 };
  const reviewPayload = () => ({ ...identity, sourceInstallationId: installationId, sourceOrgId: orgId,
    repoFullName: "octo/repository", repositoryPrivate: false, headSha, baseSha });

  beforeAll(async () => {
    if (process.env.POSTIL_KEEP_TEST_DATABASE !== "1") throw new Error("feedback tests require database retention");
    database = await createEphemeralDatabase("review_feedback");
    process.env.DATABASE_URL = database.url;
    process.env.POSTIL_REVIEW_FEEDBACK_ENABLED = "1";
    const org = await database.pool.query("INSERT INTO organizations (slug, name, github_org_id) VALUES ('feedback-owner', 'Feedback owner', 91) RETURNING id");
    orgId = Number(org.rows[0].id);
    const installation = await database.pool.query(`INSERT INTO installations
      (github_installation_id, org_id, account_login, account_type) VALUES (81, $1, 'octo', 'Organization') RETURNING id`, [orgId]);
    installationId = Number(installation.rows[0].id);
    const repository = await database.pool.query(`INSERT INTO repositories
      (installation_id, github_repo_id, full_name, enabled, private) VALUES ($1, 71, 'octo/repository', true, false) RETURNING id`, [installationId]);
    repositoryId = Number(repository.rows[0].id);
    const review = await database.pool.query(`INSERT INTO reviews
      (repository_id, source_org_id, source_installation_id, source_github_installation_id, source_github_repo_id,
       source_repo_full_name, pr_number, head_sha, base_sha, status, author_github_id, author_login, finished_at)
      VALUES ($1, $2, $3, 81, 71, 'octo/repository', 17, $4, $5, 'completed', 51, 'maintainer', now()) RETURNING id`,
    [repositoryId, orgId, installationId, "c".repeat(40), baseSha]);
    await database.pool.query(`INSERT INTO finding_publications
      (review_id, finding_id, stable_identity, initial_state, current_state, github_comment_id)
      VALUES ($1, 'historical-backup-finding', true, 'inline', 'resolved', $2)`, [review.rows[0].id, String(rootId)]);
    await database.pool.query(`INSERT INTO reviews
      (repository_id, source_org_id, source_installation_id, source_github_installation_id, source_github_repo_id,
       source_repo_full_name, pr_number, head_sha, base_sha, status, author_github_id, author_login, finished_at)
      VALUES ($1, $2, $3, 81, 71, 'octo/repository', 17, $4, $5, 'failed', 51, 'maintainer', now())`,
    [repositoryId, orgId, installationId, headSha, baseSha]);
    globalThis.fetch = (async () => Response.json({ data: { repository: { databaseId: 71, nameWithOwner: "octo/repository",
      pullRequest: { headRefOid: headSha, state: "OPEN", isDraft: false, reviewThreads: {
        nodes: [{ isResolved: true, resolvedBy: { __typename: "User", databaseId: 51, login: "maintainer" },
          comments: { nodes: [
            { databaseId: String(rootId), author: { __typename: "Bot", login: "postil-dev[bot]" } },
            { databaseId: String(rootId + 1), author: { __typename: "User", databaseId: 51, login: "maintainer" }, body: reply, updatedAt },
            { databaseId: String(rootId + 2), author: { __typename: "Bot", login: "postil-dev[bot]" }, body: "Rechecking.", updatedAt },
          ], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false },
      } } } } })) as unknown as typeof fetch;
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await closeDb();
    if (originalDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabase;
    if (originalEnabled === undefined) delete process.env.POSTIL_REVIEW_FEEDBACK_ENABLED;
    else process.env.POSTIL_REVIEW_FEEDBACK_ENABLED = originalEnabled;
    await database?.drop();
  });

  test("recovers historical evidence once, isolates old consumers, and retains context through legacy coalescing", async () => {
    const pool = database.pool;
    await reconcileReviewFeedback(identity, pool);
    let jobs = await pool.query("SELECT id, kind, payload FROM jobs WHERE kind IN ('review', 'review-feedback') ORDER BY id");
    expect(jobs.rows).toHaveLength(1);
    const first = jobs.rows[0];
    expect(first.kind).toBe("review-feedback");
    for (const field of ["installationId", "sourceOrgId", "sourceInstallationId", "githubRepoId", "repoFullName", "prNumber", "headSha", "baseSha"]) {
      await expect(pool.query("UPDATE jobs SET payload = jsonb_set(payload, ARRAY[$2]::text[], '\"changed\"'::jsonb) WHERE id = $1", [first.id, field]))
        .rejects.toThrow("publication identity is immutable");
    }
    await expect(pool.query("UPDATE jobs SET kind = 'review' WHERE id = $1", [first.id]))
      .rejects.toThrow("publication identity is immutable");
    expect(first.payload.reviewFeedback.threads[0]).toMatchObject({ findingId: "historical-backup-finding",
      rootCommentId: rootId, comments: [{ commentId: rootId + 1, body: reply }] });
    expect(first.payload.reviewFeedback.threads[0].comments).toHaveLength(1);
    await reconcileReviewFeedback(identity, pool);
    expect((await pool.query("SELECT count(*)::int AS count FROM review_feedback_requests")).rows[0].count).toBe(1);
    expect(await claimJob(pool, "old-consumer", ["review"])).toBeNull();

    // An older queued-work producer cannot erase exact same-head evidence.
    await pool.query("UPDATE jobs SET payload = $2::jsonb WHERE id = $1", [first.id, JSON.stringify(reviewPayload())]);
    expect((await pool.query("SELECT kind, payload FROM jobs WHERE id = $1", [first.id])).rows[0])
      .toMatchObject({ kind: "review-feedback", payload: { reviewFeedback: first.payload.reviewFeedback } });
    await pool.query("UPDATE jobs SET status = 'done' WHERE id = $1", [first.id]);
    await reconcileReviewFeedback(identity, pool);
    expect((await pool.query("SELECT count(*)::int AS count FROM jobs WHERE kind = 'review-feedback'")).rows[0].count).toBe(1);

    const queuedId = await enqueueReviewJobOnce(pool, reviewPayload());
    reply += " The deployment order is explicit.";
    updatedAt = "2026-09-01T12:01:00Z";
    await reconcileReviewFeedback(identity, pool);
    expect((await pool.query("SELECT kind FROM jobs WHERE id = $1", [queuedId])).rows[0].kind).toBe("review-feedback");
    expect(await claimJob(pool, "old-consumer", ["review"])).toBeNull();
    await pool.query("UPDATE jobs SET status = 'done' WHERE id = $1", [queuedId]);

    // Feedback arriving during a normal review survives the old completion SQL.
    const regularId = await enqueueReviewJobOnce(pool, reviewPayload());
    await pool.query("UPDATE jobs SET status = 'running', locked_by = 'old-consumer', locked_at = now() WHERE id = $1", [regularId]);
    reply += " The restore precedes reliance on persistent identities.";
    updatedAt = "2026-09-01T12:02:00Z";
    await reconcileReviewFeedback(identity, pool);
    const pending = (await pool.query("SELECT payload->'_postilCoalescedReviewPayload' AS pending FROM jobs WHERE id = $1", [regularId])).rows[0].pending;
    expect(pending.reviewFeedback.threads[0].comments[0].body).toBe(reply);
    await pool.query("UPDATE jobs SET payload = jsonb_set(payload, '{_postilCoalescedReviewPayload}', $2::jsonb) WHERE id = $1",
      [regularId, JSON.stringify(reviewPayload())]);
    await pool.query(`WITH finished AS (
      UPDATE jobs SET status = 'done' WHERE id = $1 RETURNING payload, max_attempts
    ) INSERT INTO jobs (kind, payload, max_attempts)
      SELECT 'review', payload->'_postilCoalescedReviewPayload', max_attempts FROM finished`, [regularId]);
    jobs = await pool.query("SELECT kind, payload FROM jobs WHERE status = 'queued' AND kind IN ('review', 'review-feedback')");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].kind).toBe("review-feedback");
    expect(jobs.rows[0].payload.reviewFeedback.threads[0].comments[0].body).toBe(reply);
    expect(await claimJob(pool, "old-consumer", ["review"])).toBeNull();
    const claimed = await claimJob(pool, "feedback-consumer", ["review-feedback"]);
    expect(claimed?.kind).toBe("review-feedback");
    const preserved = claimed!.payload;
    expect(await requeueJobsOwnedBy(pool, "feedback-consumer", "interrupted", ["review", "review-feedback"], [claimed!.id])).toBe(1);
    let state = (await pool.query("SELECT status, attempts, payload FROM jobs WHERE id = $1", [claimed!.id])).rows[0];
    expect(state).toMatchObject({ status: "queued", attempts: 0, payload: preserved });
    await claimJob(pool, "feedback-consumer", ["review-feedback"]);
    expect(await deferHostedReviewForRelease(pool, { id: claimed!.id, lockedBy: "feedback-consumer", kind: "review-feedback" }, headSha)).toBe("deferred");
    state = (await pool.query("SELECT status, attempts, run_after = 'infinity'::timestamptz AS parked, payload FROM jobs WHERE id = $1", [claimed!.id])).rows[0];
    expect(state).toMatchObject({ status: "queued", attempts: 0, parked: true, payload: { reviewFeedback: preserved.reviewFeedback } });
    await activateHostedInferenceRelease(pool, headSha);
    state = (await pool.query("SELECT status, attempts, run_after <= now() AS ready, payload FROM jobs WHERE id = $1", [claimed!.id])).rows[0];
    expect(state).toMatchObject({ status: "queued", attempts: 0, ready: true, payload: { reviewFeedback: preserved.reviewFeedback } });
    expect((await pool.query("SELECT count(*)::int AS count FROM finding_approvals")).rows[0].count).toBe(0);
  });

  test("a cancelled final context read cannot admit a feedback request", async () => {
    const pool = database.pool;
    const before = (await pool.query("SELECT count(*)::int AS count FROM review_feedback_requests")).rows[0].count;
    reply += " A further explanation.";
    updatedAt = "2026-09-01T12:03:00Z";
    rejectContextRead = true;
    try {
      await expect(reconcileReviewFeedback(identity, pool)).rejects.toThrow("context request aborted");
      expect(contextSignal).toBeInstanceOf(AbortSignal);
      expect((await pool.query("SELECT count(*)::int AS count FROM review_feedback_requests")).rows[0].count).toBe(before);
    } finally { rejectContextRead = false; }
  });

  test("admits only authorized humans and deduplicates event and poll wake-ups", async () => {
    const pool = database.pool;
    const event = { ...identity, rootCommentId: rootId, actor: { id: 51, login: "maintainer", type: "User" } };
    expect(await admitReviewFeedbackEvent({ ...event, actor: { id: 52, login: "visitor", type: "User" } }, pool)).toBe(false);
    expect(await admitReviewFeedbackEvent({ ...event, actor: { id: 51, login: "maintainer", type: "Bot" } }, pool)).toBe(false);
    expect(await admitReviewFeedbackEvent({ ...event, rootCommentId: rootId + 100 }, pool)).toBe(false);
    expect(await admitReviewFeedbackEvent(event, pool)).toBe(true);
    expect(await admitReviewFeedbackEvent(event, pool)).toBe(false);
    expect(await scheduleReviewFeedbackReconciliationJobs(pool, new Date(Date.now() + 6 * 60_000))).toBe(0);
    authority = "unavailable";
    await expect(admitReviewFeedbackEvent(event, pool)).rejects.toThrow("authority is unavailable");
    authority = "authorized";
  });
});
