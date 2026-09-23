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
const realEntitlement = await import("@/lib/private-repository-entitlement");
mock.module("@/lib/private-repository-entitlement", () => ({ ...realEntitlement,
  canProcessRepositoryInference: async () => ({ allowed: true }),
}));

const { admitReviewFeedbackEvent, reconcileReviewFeedback, reviewFeedbackDigest, reviewFeedbackEnabled, scheduleReviewFeedbackReconciliationJobs } = await import("@/lib/review-feedback");
const { claimJob, completeJob, enqueueJob, enqueueReviewJobOnce, failJob, requeueJobsOwnedBy } = await import("@/lib/queue");
const { deferHostedReviewForRelease, activateHostedInferenceRelease } = await import("@/lib/release-job-rollout");
const { closeDb } = await import("@/lib/db");
const { controlReviewFeedbackMode } = await import("../scripts/control-review-feedback");
const { watchdogPass } = await import("@/worker/watchdog");

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

  test("database control overrides the process flag and preserves inherit semantics", async () => {
    const pool = database.pool;
    const original = process.env.POSTIL_REVIEW_FEEDBACK_ENABLED;
    const event = { ...identity, rootCommentId: rootId, actor: { id: 51, login: "maintainer", type: "User" } };
    try {
      expect((await pool.query("SELECT id, mode FROM review_feedback_control")).rows).toEqual([{ id: 1, mode: "inherit" }]);
      process.env.POSTIL_REVIEW_FEEDBACK_ENABLED = "0";
      expect(await reviewFeedbackEnabled(pool)).toBe(false);
      await pool.query("UPDATE review_feedback_control SET mode = 'enabled' WHERE id = 1");
      expect(await reviewFeedbackEnabled(pool)).toBe(true);
      expect(await admitReviewFeedbackEvent(event, pool)).toBe(true);
      await pool.query("UPDATE jobs SET status = 'done' WHERE kind = 'review-feedback-reconciliation' AND status = 'queued'");
      process.env.POSTIL_REVIEW_FEEDBACK_ENABLED = "1";
      await pool.query("UPDATE review_feedback_control SET mode = 'disabled' WHERE id = 1");
      expect(await reviewFeedbackEnabled(pool)).toBe(false);
      expect(await admitReviewFeedbackEvent(event, pool)).toBe(false);
      expect(await scheduleReviewFeedbackReconciliationJobs(pool)).toBe(0);
      await reconcileReviewFeedback(identity, pool);
      expect((await pool.query("SELECT count(*)::int AS count FROM jobs WHERE kind IN ('review-feedback', 'review-feedback-reconciliation') AND status = 'queued'")).rows[0].count).toBe(0);
      await pool.query("UPDATE review_feedback_control SET mode = 'inherit' WHERE id = 1");
      expect(await reviewFeedbackEnabled(pool)).toBe(true);
      await expect(pool.query("INSERT INTO review_feedback_control (mode) VALUES ('enabled')"))
        .rejects.toThrow();
      await expect(pool.query("UPDATE review_feedback_control SET mode = 'invalid' WHERE id = 1"))
        .rejects.toThrow();
    } finally {
      await pool.query("UPDATE review_feedback_control SET mode = 'inherit' WHERE id = 1");
      if (original === undefined) delete process.env.POSTIL_REVIEW_FEEDBACK_ENABLED;
      else process.env.POSTIL_REVIEW_FEEDBACK_ENABLED = original;
    }
  });

  test("a failed or missing control read cannot admit or schedule feedback", async () => {
    const failed = { query: async () => { throw new Error("control read failed"); } } as unknown as typeof database.pool;
    const missing = { query: async () => ({ rows: [] }) } as unknown as typeof database.pool;
    const event = { ...identity, rootCommentId: rootId, actor: { id: 51, login: "maintainer", type: "User" } };
    expect(await reviewFeedbackEnabled(missing)).toBe(false);
    expect(await reviewFeedbackEnabled(failed)).toBe(false);
    expect(await admitReviewFeedbackEvent(event, failed)).toBe(false);
    expect(await scheduleReviewFeedbackReconciliationJobs(failed)).toBe(0);
    await reconcileReviewFeedback(identity, failed);
  });

  test("operator control dry-runs and changes only the expected database mode", async () => {
    const pool = database.pool;
    try {
      expect(await controlReviewFeedbackMode(pool, "inherit", "enabled", false)).toBe("dry-run");
      expect((await pool.query("SELECT mode FROM review_feedback_control WHERE id = 1")).rows[0].mode)
        .toBe("inherit");
      expect(await controlReviewFeedbackMode(pool, "inherit", "enabled", true)).toBe("confirmed");
      await expect(controlReviewFeedbackMode(pool, "inherit", "disabled", true)).rejects.toThrow(
        "does not match the expected mode",
      );
      expect((await pool.query("SELECT mode FROM review_feedback_control WHERE id = 1")).rows[0].mode)
        .toBe("enabled");
      expect(await controlReviewFeedbackMode(pool, "enabled", "disabled", true)).toBe("confirmed");
      expect(await reviewFeedbackEnabled(pool)).toBe(false);
    } finally {
      await pool.query("UPDATE review_feedback_control SET mode = 'inherit' WHERE id = 1");
    }
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

  test("generic watchdog recovery retains an interrupted polling job and its retry budget", async () => {
    const pool = database.pool;
    const poll = (await pool.query("SELECT id, payload FROM jobs WHERE kind = 'review-feedback-reconciliation' AND status = 'queued' LIMIT 1")).rows[0];
    expect(poll).toBeDefined();
    await pool.query("UPDATE jobs SET status = 'running', attempts = 1, locked_by = 'interrupted-poller', locked_at = now() - interval '11 minutes' WHERE id = $1", [poll.id]);
    await watchdogPass();
    const recovered = (await pool.query("SELECT kind, status, attempts, max_attempts, payload, locked_by FROM jobs WHERE id = $1", [poll.id])).rows[0];
    expect(recovered).toEqual({ kind: "review-feedback-reconciliation", status: "queued", attempts: 1,
      max_attempts: 5, payload: poll.payload, locked_by: null });
    expect(await scheduleReviewFeedbackReconciliationJobs(pool, new Date(Date.now() + 60 * 60_000))).toBe(0);
    const claimed = await claimJob(pool, "replacement-poller", ["review-feedback-reconciliation"]);
    expect(claimed?.payload).toEqual(poll.payload);
  });

  test("head changes isolate evidence while same-head coalescing retains its exact trigger digest", async () => {
    const pool = database.pool;
    const firstHead = "e".repeat(40);
    const nextHead = "f".repeat(40);
    const normal = (head: string) => ({ ...reviewPayload(), prNumber: 61, headSha: head });
    const feedback = (head: string, body: string) => {
      const reviewFeedback = { version: 1 as const, repository: "octo/repository", prNumber: 61, headSha: head,
        threads: [{ findingId: "finding", rootCommentId: rootId, resolved: false,
          comments: [{ commentId: rootId + 1, author: { id: 51, login: "maintainer" }, body, updatedAt }] }] };
      return { ...normal(head), reviewFeedback,
        trigger: { source: "finding_feedback" as const, feedbackDigest: reviewFeedbackDigest(reviewFeedback) } };
    };
    const first = feedback(firstHead, "Evidence on the first head.");
    const firstId = await enqueueReviewJobOnce(pool, first);
    const nextId = await enqueueReviewJobOnce(pool, normal(nextHead));
    expect(nextId).not.toBe(firstId);
    let payload = (await pool.query("SELECT payload FROM jobs WHERE id = $1", [nextId])).rows[0].payload;
    expect(payload.reviewFeedback).toBeUndefined();
    expect(payload.trigger).toBeUndefined();
    expect(payload.headSha).toBe(nextHead);

    const next = feedback(nextHead, "Evidence bound to the next head.");
    await enqueueReviewJobOnce(pool, next);
    await enqueueReviewJobOnce(pool, normal(nextHead));
    payload = (await pool.query("SELECT payload FROM jobs WHERE id = $1", [nextId])).rows[0].payload;
    expect(payload.reviewFeedback.headSha).toBe(nextHead);
    expect(payload.trigger.feedbackDigest).toBe(reviewFeedbackDigest(payload.reviewFeedback));
    expect(payload.trigger.feedbackDigest).not.toBe(first.trigger.feedbackDigest);

    await pool.query("UPDATE jobs SET status = 'running', locked_by = 'coalescing-worker', locked_at = now() WHERE id = $1", [nextId]);
    const edited = feedback(nextHead, "An edited explanation bound to the next head.");
    await enqueueReviewJobOnce(pool, edited);
    await enqueueReviewJobOnce(pool, normal(nextHead));
    payload = (await pool.query("SELECT payload FROM jobs WHERE id = $1", [nextId])).rows[0].payload;
    expect(payload.trigger.feedbackDigest).toBe(next.trigger.feedbackDigest);
    const pending = payload._postilCoalescedReviewPayload;
    expect(pending.headSha).toBe(nextHead);
    expect(pending.trigger.feedbackDigest).toBe(reviewFeedbackDigest(pending.reviewFeedback));
    expect(pending.trigger.feedbackDigest).toBe(edited.trigger.feedbackDigest);
  });

  for (const kind of ["review", "review-feedback"] as const) {
    test(`${kind} publication recovery retains newest feedback through queue transitions`, async () => {
      const pool = database.pool;
      const prNumber = kind === "review" ? 70 : 71;
      const base = { ...reviewPayload(), prNumber };
      const feedback = (body: string) => {
        const reviewFeedback = { version: 1 as const, repository: base.repoFullName, prNumber, headSha,
          threads: [{ findingId: "recovery", rootCommentId: rootId, resolved: false,
            comments: [{ commentId: rootId + 1, author: { id: 51, login: "maintainer" }, body, updatedAt }] }] };
        return { ...base, reviewFeedback,
          trigger: { source: "finding_feedback" as const, feedbackDigest: reviewFeedbackDigest(reviewFeedback) } };
      };
      const original = { ...(kind === "review" ? base : feedback("Original evidence")), recoveryReviewId: 1000 + prNumber };
      const id = await enqueueJob(pool, kind, original);
      const read = async () => (await pool.query("SELECT status,attempts,payload FROM jobs WHERE id=$1", [id])).rows[0];
      const count = async () => Number((await pool.query("SELECT count(*)::int AS count FROM jobs WHERE payload->>'prNumber'=$1 AND kind IN ('review','review-feedback')", [String(prNumber)])).rows[0].count);
      const claim = async (attempts: number) => {
        await pool.query("UPDATE jobs SET status='running',locked_by='recovery-owner',locked_at=now(),attempts=$2 WHERE id=$1", [id, attempts]);
        return { id, lockedBy: "recovery-owner", attempts, maxAttempts: 3 };
      };
      await enqueueReviewJobOnce(pool, feedback("First incoming evidence"));
      const latest = feedback("Latest incoming evidence");
      await enqueueReviewJobOnce(pool, latest);
      await enqueueReviewJobOnce(pool, base);
      const retained = { ...original, _postilCoalescedReviewPayload: latest };
      expect((await read()).payload).toEqual(retained);
      expect(await failJob(pool, await claim(1), "transient verification failure")).toBe("retried");
      expect((await read()).payload).toEqual(retained);
      expect(await count()).toBe(1);
      await claim(2);
      expect(await requeueJobsOwnedBy(pool, "recovery-owner", "shutdown", [kind], [id])).toBe(1);
      expect(await read()).toMatchObject({ status: "queued", attempts: 1, payload: original });
      expect(await count()).toBe(1);
      await expect(pool.query("UPDATE jobs SET payload=$2 WHERE id=$1", [id, JSON.stringify(latest)]))
        .rejects.toThrow("review recovery identity is immutable");
      expect(await completeJob(pool, await claim(2))).toBe("coalesced");
      const followups = (await pool.query("SELECT kind,payload FROM jobs WHERE id<>$1 AND payload->>'prNumber'=$2", [id, String(prNumber)])).rows;
      expect(followups).toEqual([{ kind: "review-feedback", payload: latest }]);
      expect(await completeJob(pool, { id, lockedBy: "recovery-owner" })).toBe("lost");
      expect(await count()).toBe(2);
    });
  }

  for (const withFollowup of [false, true]) {
    test(`terminal recovery failure retains pending evidence without promotion (${withFollowup})`, async () => {
      const pool = database.pool;
      const prNumber = withFollowup ? 73 : 72;
      const pending = { ...reviewPayload(), prNumber };
      const payload = { ...pending, recoveryReviewId: 1000 + prNumber, _postilCoalescedReviewPayload: pending };
      const id = await enqueueJob(pool, "review", payload);
      await pool.query("UPDATE jobs SET status='running',locked_by='terminal-owner',locked_at=now(),attempts=3 WHERE id=$1", [id]);
      expect(await failJob(pool, { id, lockedBy: "terminal-owner", attempts: 3, maxAttempts: 3 }, "terminal failure",
        withFollowup ? { permanent: true, failureFollowup: { kind: "respond-failure-comment", payload: { prNumber }, maxAttempts: 5 } } : {})).toBe("failed");
      expect((await pool.query("SELECT status,payload FROM jobs WHERE id=$1", [id])).rows[0]).toEqual({ status: "failed", payload });
      expect((await pool.query("SELECT count(*)::int AS count FROM jobs WHERE kind IN ('review','review-feedback') AND payload->>'prNumber'=$1", [String(prNumber)])).rows[0].count).toBe(1);
    });
  }

  test("finding feedback provenance requires a matching source alongside its digest", async () => {
    const insert = (context: unknown) => database.pool.query(`INSERT INTO reviews
      (repository_id, source_org_id, source_installation_id, source_github_installation_id, source_github_repo_id,
       source_repo_full_name, pr_number, head_sha, base_sha, status, author_github_id, author_login, trigger_source, trigger_context)
      VALUES ($1, $2, $3, 81, 71, 'octo/repository', 18, $4, $5, 'failed', 51, 'maintainer', 'finding_feedback', $6::jsonb)
      RETURNING trigger_context`, [repositoryId, orgId, installationId, headSha, baseSha, JSON.stringify(context)]);
    const feedbackDigest = "d".repeat(64);
    expect((await insert({ source: "finding_feedback", feedbackDigest })).rows[0].trigger_context)
      .toEqual({ source: "finding_feedback", feedbackDigest });
    for (const context of [{ feedbackDigest }, { source: null, feedbackDigest }, { source: "requested_review", feedbackDigest }]) {
      await expect(insert(context)).rejects.toMatchObject({ code: "23514", constraint: "reviews_trigger_context_check" });
    }
  });
});
