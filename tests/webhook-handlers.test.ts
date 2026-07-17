import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  signWebhookBody,
} from "@/lib/crypto/webhook";

/**
 * Behavioural coverage for the webhook route beyond delivery dedupe:
 *
 *  - a repo transferred between installations is re-pinned to the new
 *    installation on the pull_request upsert (otherwise reviews skip),
 *  - a new pull request head stales the active review and neutralizes both
 *    of its check-runs before queueing the replacement,
 *  - removing repos from an installation completes any in-flight review's
 *    check-runs before the delete cascades them away,
 *  - respond jobs are rate-limited per installation per hour, and
 *  - check_run rerequested (GitHub's "Re-run" button) re-enqueues a review
 *    job, skips unknown/disabled repos, and does not double-enqueue over an
 *    already in-flight job for the same repo+PR+head.
 *
 * The GitHub token mint and check-run PATCH are stubbed so the suite stays
 * hermetic; everything else runs against a real Postgres. Set
 * POSTIL_TEST_DATABASE_URL to run; skipped otherwise.
 */

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

const WEBHOOK_SECRET = "test-webhook-secret-for-handlers";

// Record check-run completions the removal path drives, and hand back a fake
// installation token so no real GitHub App credentials are needed. Spread the
// real module: other importers use its remaining exports, and a bare override
// object would break their import chains.
const completedCheckRuns: Array<{ repoFullName: string; conclusion: string }> = [];
const postedComments: Array<{ repoFullName: string; number: number; body: string }> = [];
let pullRequestHeadSha = "head-sha";
let pullRequestReviewContext = {
  headSha: "head-sha",
  baseSha: "base-sha",
  draft: false,
  authorGithubId: 501,
  authorLogin: "admin",
};
const realAppAuth = await import("@/lib/github/app-auth");
const realChecks = await import("@/lib/github/checks");
mock.module("@/lib/github/app-auth", () => ({
  ...realAppAuth,
  getInstallationToken: async () => "fake-installation-token",
}));
mock.module("@/lib/github/checks", () => ({
  ...realChecks,
  ADVISORY_CHECK_NAME: "postil/review",
  GATE_CHECK_NAME: "postil/gate",
  createCheckRun: async () => 1,
  completeCheckRun: async (
    _token: string,
    repoFullName: string,
    _id: number,
    conclusion: string,
  ) => {
    completedCheckRuns.push({ repoFullName, conclusion });
  },
  getPullRequestHeadSha: async () => pullRequestHeadSha,
  getPullRequestReviewContext: async () => pullRequestReviewContext,
  findIssueCommentByMarker: async () => null,
  postIssueComment: async (_token: string, repoFullName: string, number: number, body: string) => {
    postedComments.push({ repoFullName, number, body });
    return 123;
  },
}));

// Imported after the mocks are registered so the route picks up the stubs.
const { POST } = await import("@/app/api/webhooks/github/route");
const { getDb, getPool } = await import("@/lib/db");
const { hasNewerCompletedReviewForHead } = await import("@/lib/finding-approvals");
const { claimJob } = await import("@/lib/queue");
const { runClaimedJob } = await import("@/worker/runner");

async function post(event: string, body: object, deliveryId: string): Promise<Response> {
  const raw = JSON.stringify(body);
  const response = await POST(
    new Request("https://postil.dev/api/webhooks/github", {
      method: "POST",
      body: raw,
      headers: {
        "x-hub-signature-256": signWebhookBody(raw, WEBHOOK_SECRET),
        "x-github-delivery": deliveryId,
        "x-github-event": event,
        "content-type": "application/json",
      },
    }),
  );
  const result = (await response.clone().json()) as { queued?: boolean };
  if (result.queued) {
    const job = await claimJob(getPool(), "webhook-handler-test", ["webhook-dispatch"]);
    expect(job?.kind).toBe("webhook-dispatch");
    await runClaimedJob(job!, "webhook-handler-test", "web");
  }
  return response;
}

test("rejects an oversized declared webhook before reading or authenticating it", async () => {
  const request = new Request("https://postil.dev/api/webhooks/github", {
    method: "POST",
    body: "{}",
    headers: { "content-length": String(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1) },
  });

  const response = await POST(request);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "payload too large" });
  expect(request.bodyUsed).toBe(false);
});

describeDb("webhook handler behaviour", () => {
  let pool: Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "0";
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
          if (code !== "42P07" && code !== "42710" && code !== "42701") throw err;
        }
      }
    }
  });

  beforeEach(async () => {
    completedCheckRuns.length = 0;
    postedComments.length = 0;
    pullRequestHeadSha = "head-sha";
    pullRequestReviewContext = {
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
      authorGithubId: 501,
      authorLogin: "admin",
    };
    delete process.env.POSTIL_RESPOND_HOURLY_CAP;
    await pool.query("TRUNCATE respond_deliveries, jobs RESTART IDENTITY");
    await pool.query("TRUNCATE webhook_deliveries");
    await pool.query(
      "TRUNCATE reviews, repositories, installations, organizations RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedOrg(): Promise<number> {
    const org = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('octo', 'octo', 999) RETURNING id",
    );
    return Number(org.rows[0]!.id);
  }

  async function queuedWebhookCommentBodies(): Promise<string[]> {
    const result = await pool.query<{ body: string }>(
      `SELECT payload->>'body' AS body
         FROM jobs
        WHERE kind = 'webhook-comment'
        ORDER BY id`,
    );
    return result.rows.map((row) => row.body);
  }

  async function seedInstallation(orgId: number, githubInstallationId: number): Promise<number> {
    const inst = await pool.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, org_id, account_login, account_type, suspended)
       VALUES ($1, $2, 'octo', 'Organization', false) RETURNING id`,
      [githubInstallationId, orgId],
    );
    return Number(inst.rows[0]!.id);
  }

  async function seedRepo(
    installationId: number,
    githubRepoId: number,
    fullName: string,
    privateRepository = false,
  ): Promise<number> {
    const repo = await pool.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [installationId, githubRepoId, fullName, privateRepository],
    );
    return Number(repo.rows[0]!.id);
  }

  async function seedSharedSnapshot(
    orgId: number,
    repositoryId: number,
    githubRepoId: number,
    fullName = "octo/.github",
  ): Promise<void> {
    await pool.query(
      `INSERT INTO org_config_snapshots
         (org_id, source_repository_id, source_github_repo_id, source_full_name,
          visibility, default_branch, commit_sha, files, loaded_files, fetched_at)
       VALUES ($1, $2, $3, $4, 'private', 'main', $5, $6, $6, now())`,
      [orgId, repositoryId, githubRepoId, fullName, "a".repeat(40), [".postil.yaml"]],
    );
  }

  async function seedUser(
    githubId: number,
    login: string,
    orgId: number,
    role: "member" | "admin",
  ): Promise<number> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (github_id, login) VALUES ($1, $2)
       ON CONFLICT (github_id) DO UPDATE SET login = excluded.login
       RETURNING id`,
      [githubId, login],
    );
    const userId = Number(user.rows[0]!.id);
    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role`,
      [orgId, userId, role],
    );
    return userId;
  }

  function approvalEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      summary: "Escalation requires admin approval.",
      silent: false,
      findings: [
        {
          id: "kind-blocker",
          path: "src/app.ts",
          line: 10,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.9,
          title: "Manual approval required",
          body: "The policy escalated this change.",
        },
      ],
      resolved: [],
      counts: { info: 0, warn: 1, error: 0, suppressed: 0, ungrounded: 0 },
      confidenceBuckets: [0, 0, 0, 0, 1],
      gate: { failOn: "error", failing: true, block_on_kinds: ["humanEscalation"] },
      modelUsed: "deepseek/deepseek-v4-pro",
      usage: { promptTokens: 1, completionTokens: 1 },
      durationMs: 1,
      baseSha: "base-sha",
      headSha: "head-sha",
      sinceSha: null,
      ...overrides,
    };
  }

  async function seedCompletedApprovalReview(
    repoId: number,
    envelope: Record<string, unknown> = approvalEnvelope(),
  ): Promise<number> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, envelope, silent,
          engine_gate_failing, gate_failing, gate_check_run_id, finished_at)
       VALUES ($1, 9, 'head-sha', 'base-sha', 'completed', $2, false, true, true, 900, now())
       RETURNING id`,
      [repoId, JSON.stringify(envelope)],
    );
    return Number(row.rows[0]!.id);
  }

  function approvalComment(
    deliveryId: string,
    body = "@postil approve kind-blocker -- reviewed",
    privateRepository = false,
  ): Promise<Response> {
    return post(
      "issue_comment",
      {
        action: "created",
        installation: { id: 700 },
        repository: { id: 7000, full_name: "octo/approvals", private: privateRepository },
        sender: { id: 501, login: "admin", type: "User" },
        comment: {
          id: 123456,
          html_url: "https://github.com/octo/approvals/pull/9#issuecomment-123456",
          body,
          user: { id: 501, login: "admin", type: "User" },
          author_association: "MEMBER",
        },
        issue: { number: 9, pull_request: {} },
      },
      deliveryId,
    );
  }

  test("pull_request upsert re-pins a repo transferred between installations", async () => {
    const orgId = await seedOrg();
    const oldInst = await seedInstallation(orgId, 100);
    const newInst = await seedInstallation(orgId, 200);
    // Repo currently owned by the old installation.
    await seedRepo(oldInst, 7777, "octo/repo");

    // A pull_request event arrives under the NEW installation.
    const res = await post(
      "pull_request",
      {
        action: "opened",
        number: 7,
        installation: { id: 200 },
        repository: { id: 7777, full_name: "octo/repo", private: false },
        pull_request: {
          number: 7,
          head: { sha: "h" },
          base: { sha: "b" },
          user: { id: 4242, login: "dependabot[bot]", type: "Bot" },
        },
      },
      "delivery-transfer-1",
    );
    expect(res.status).toBe(200);

    // The repo row must now point at the new installation, not the old one.
    const row = await pool.query<{ installation_id: string }>(
      "SELECT installation_id FROM repositories WHERE github_repo_id = 7777",
    );
    expect(Number(row.rows[0]!.installation_id)).toBe(newInst);

    // And the review job was enqueued (installation resolved, repo enabled).
    const jobs = await pool.query<{
      payload: { authorGithubId: number; authorLogin: string };
    }>(
      "SELECT payload FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload).toMatchObject({
      authorGithubId: 4242,
      authorLogin: "dependabot[bot]",
    });
  });

  test("pull_request synchronize neutralizes superseded review check-runs", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 250);
    const repoId = await seedRepo(inst, 7878, "octo/repo");
    const old = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status,
          advisory_check_run_id, gate_check_run_id, queued_at, started_at)
       VALUES ($1, 7, 'old-head', 'base', 'running', 11, 22,
               now() - interval '1 minute', now() - interval '50 seconds')
       RETURNING id`,
      [repoId],
    );

    const res = await post(
      "pull_request",
      {
        action: "synchronize",
        installation: { id: 250 },
        repository: { id: 7878, full_name: "octo/repo", private: false },
        pull_request: {
          number: 7,
          head: { sha: "new-head" },
          base: { sha: "base" },
        },
      },
      "delivery-synchronize-1",
    );

    expect(res.status).toBe(200);
    const review = await pool.query<{ status: string; finished_at: Date | null }>(
      "SELECT status, finished_at FROM reviews WHERE id = $1",
      [old.rows[0]!.id],
    );
    expect(review.rows[0]!.status).toBe("stale");
    expect(review.rows[0]!.finished_at).toBeInstanceOf(Date);
    expect(completedCheckRuns).toEqual([
      { repoFullName: "octo/repo", conclusion: "neutral" },
      { repoFullName: "octo/repo", conclusion: "neutral" },
    ]);
    const jobs = await pool.query<{ payload: { headSha: string } }>(
      "SELECT payload FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload.headSha).toBe("new-head");
  });

  test("private repositories without entitlement produce no jobs, reviews, checks, or comments across webhook paths", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 260);
    await seedRepo(inst, 7979, "octo/private", true);
    const repository = { id: 7979, full_name: "octo/private", private: true };

    expect((await post("pull_request", {
      action: "opened",
      installation: { id: 260 },
      repository,
      pull_request: { number: 7, head: { sha: "head" }, base: { sha: "base" } },
    }, "private-pull")).status).toBe(200);
    expect((await post("check_run", {
      action: "rerequested",
      installation: { id: 260 },
      repository,
      check_run: {
        name: "postil/gate",
        head_sha: "head",
        pull_requests: [{ number: 7, head: { sha: "head" }, base: { sha: "base" } }],
      },
    }, "private-rerequest")).status).toBe(200);
    const comment = {
      body: "@postil please help",
      user: { login: "maintainer", type: "User" },
      author_association: "MEMBER",
    };
    expect((await post("issue_comment", {
      action: "created",
      installation: { id: 260 },
      repository,
      sender: { login: "maintainer", type: "User" },
      comment,
      issue: { number: 7, pull_request: {} },
    }, "private-issue-comment")).status).toBe(200);
    expect((await post("pull_request_review_comment", {
      action: "created",
      installation: { id: 260 },
      repository,
      sender: { login: "maintainer", type: "User" },
      comment: { ...comment, path: "src/app.ts", line: 2 },
      pull_request: { number: 7 },
    }, "private-review-comment")).status).toBe(200);
    expect((await post("issues", {
      action: "opened",
      installation: { id: 260 },
      repository,
      sender: { login: "maintainer", type: "User" },
      issue: { number: 8, body: "@postil please help", author_association: "MEMBER" },
    }, "private-issue")).status).toBe(200);
    const [jobs, reviews] = await Promise.all([
      pool.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM jobs WHERE kind <> 'webhook-dispatch'",
      ),
      pool.query<{ c: number }>("SELECT count(*)::int AS c FROM reviews"),
    ]);
    expect(jobs.rows[0]!.c).toBe(0);
    expect(reviews.rows[0]!.c).toBe(0);
    expect(completedCheckRuns).toEqual([]);
    expect(postedComments).toEqual([]);
  });

  test("private approval commands remain available without billing entitlement", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals", true);
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(repoId);

    expect((await approvalComment("private-approval", undefined, true)).status).toBe(200);
    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals WHERE revoked_at IS NULL",
    );
    expect(approvals.rows[0]!.c).toBe(1);
    expect((await queuedWebhookCommentBodies())[0]).toContain("Approval recorded by @admin");
  });

  test("installation_repositories removed completes in-flight review check-runs then deletes", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 300);
    const repoId = await seedRepo(inst, 8888, "octo/gone");
    // A review still running for that repo, with both check-run ids set.
    await pool.query(
      `INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status, advisory_check_run_id, gate_check_run_id, started_at)
       VALUES ($1, 5, 'h', 'b', 'running', 11, 22, now())`,
      [repoId],
    );

    const res = await post(
      "installation_repositories",
      {
        action: "removed",
        installation: { id: 300 },
        repositories_removed: [{ id: 8888, full_name: "octo/gone", private: false }],
      },
      "delivery-removed-1",
    );
    expect(res.status).toBe(200);

    // The gate (failure) and advisory (neutral) check-runs were both completed
    // before the repo row (and its cascaded review) was deleted.
    expect(completedCheckRuns).toHaveLength(2);
    expect(completedCheckRuns.map((c) => c.conclusion).sort()).toEqual(["failure", "neutral"]);
    expect(completedCheckRuns.every((c) => c.repoFullName === "octo/gone")).toBe(true);

    const repos = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM repositories WHERE github_repo_id = 8888",
    );
    expect(repos.rows[0]!.c).toBe(0);
  });

  test("removing the shared source repository retains its revocation marker", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 301);
    const repoId = await seedRepo(inst, 8889, "octo/.github");
    await seedSharedSnapshot(orgId, repoId, 8889);

    const res = await post(
      "installation_repositories",
      {
        action: "removed",
        installation: { id: 301 },
        repositories_removed: [{ id: 8889, full_name: "octo/.github", private: true }],
      },
      "delivery-shared-removed",
    );

    expect(res.status).toBe(200);
    const snapshots = await pool.query<{ c: number; source_repository_id: string | null }>(
      `SELECT count(*)::int AS c, max(source_repository_id)::text AS source_repository_id
         FROM org_config_snapshots WHERE org_id = $1`,
      [orgId],
    );
    expect(snapshots.rows[0]!.c).toBe(1);
    expect(snapshots.rows[0]!.source_repository_id).toBeNull();
  });

  test("uninstalling the App deletes the owner snapshot", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 302);
    const repoId = await seedRepo(inst, 8890, "octo/.github");
    await seedSharedSnapshot(orgId, repoId, 8890);

    const res = await post(
      "installation",
      {
        action: "deleted",
        installation: {
          id: 302,
          account: { id: 999, login: "octo", type: "Organization" },
        },
      },
      "delivery-shared-uninstalled",
    );

    expect(res.status).toBe(200);
    const snapshots = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM org_config_snapshots WHERE org_id = $1",
      [orgId],
    );
    expect(snapshots.rows[0]!.c).toBe(0);
  });

  test("respond jobs are rate-limited per installation per hour", async () => {
    process.env.POSTIL_RESPOND_HOURLY_CAP = "2";
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 400);
    await seedRepo(inst, 9999, "octo/chatty");

    function commentEvent(deliveryId: string): Promise<Response> {
      return post(
        "issue_comment",
        {
          action: "created",
          installation: { id: 400 },
          repository: { id: 9999, full_name: "octo/chatty", private: false },
          sender: { login: "maintainer", type: "User" },
          comment: {
            body: "@postil please help",
            user: { login: "maintainer", type: "User" },
            author_association: "MEMBER",
          },
          issue: { number: 3 },
        },
        deliveryId,
      );
    }

    // First two qualifying comments enqueue; the third is over the cap.
    expect((await commentEvent("c1")).status).toBe(200);
    expect((await commentEvent("c2")).status).toBe(200);
    expect((await commentEvent("c3")).status).toBe(200);

    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'respond'",
    );
    expect(jobs.rows[0]!.c).toBe(2);
  });

  test("approval command records an active kind-block approval and clears the gate", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    const reviewId = await seedCompletedApprovalReview(repoId);

    const res = await approvalComment("approval-success");

    expect(res.status).toBe(200);
    const approvals = await pool.query<{ finding_id: string; source: string; revoked_at: Date | null }>(
      "SELECT finding_id, source, revoked_at FROM finding_approvals WHERE review_id = $1",
      [reviewId],
    );
    expect(approvals.rows).toEqual([
      { finding_id: "kind-blocker", source: "github", revoked_at: null },
    ]);
    const review = await pool.query<{ gate_failing: boolean }>(
      "SELECT gate_failing FROM reviews WHERE id = $1",
      [reviewId],
    );
    expect(review.rows[0]!.gate_failing).toBe(false);
    expect(completedCheckRuns).toEqual([]);
    const syncJobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'gate-state-sync'",
    );
    expect(syncJobs.rows[0]!.c).toBe(1);
    const replies = await queuedWebhookCommentBodies();
    expect(replies[0]).toContain("Approval recorded by @admin");
    expect(replies[0]).toContain("gate update is queued");
    expect(replies[0]).toContain("head-sha");
  });

  test("free-form mentions continue through respond path without approvals", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedCompletedApprovalReview(repoId);

    const res = await approvalComment("approval-free-form", "@postil can you explain this?");

    expect(res.status).toBe(200);
    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals",
    );
    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'respond'",
    );
    expect(approvals.rows[0]!.c).toBe(0);
    expect(jobs.rows[0]!.c).toBe(1);
  });

  test("exact PR review mentions enqueue the structured reviewer", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    await seedRepo(inst, 7000, "octo/approvals");

    const res = await approvalComment(
      "mention-review-current-head",
      "@postil rerun the review for the current head. The previous hosted run ended without a review verdict.",
    );

    expect(res.status).toBe(200);
    const jobs = await pool.query<{ kind: string; payload: Record<string, unknown> }>(
      "SELECT kind, payload FROM jobs WHERE kind <> 'webhook-dispatch' ORDER BY id",
    );
    expect(jobs.rows).toEqual([
      {
        kind: "review",
        payload: expect.objectContaining({
          installationId: 700,
          repoFullName: "octo/approvals",
          prNumber: 9,
          headSha: "head-sha",
          baseSha: "base-sha",
          authorGithubId: 501,
          authorLogin: "admin",
        }),
      },
    ]);
  });

  test("issue review mentions cannot invoke the pull-request reviewer", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 701);
    await seedRepo(inst, 7001, "octo/issues");

    const res = await post(
      "issue_comment",
      {
        action: "created",
        installation: { id: 701 },
        repository: { id: 7001, full_name: "octo/issues", private: false },
        sender: { id: 501, login: "admin", type: "User" },
        comment: {
          body: "@postil review the current head",
          user: { id: 501, login: "admin", type: "User" },
          author_association: "MEMBER",
        },
        issue: { number: 4 },
      },
      "issue-review-command",
    );

    expect(res.status).toBe(200);
    const jobs = await pool.query<{ kind: string; payload: Record<string, unknown> }>(
      "SELECT kind, payload FROM jobs WHERE kind <> 'webhook-dispatch' ORDER BY id",
    );
    expect(jobs.rows).toEqual([
      {
        kind: "webhook-comment",
        payload: expect.objectContaining({
          repoFullName: "octo/issues",
          number: 4,
          body: "Review commands only work on pull requests.",
          sourceDeliveryId: "issue-review-command",
        }),
      },
    ]);
    expect(postedComments).toEqual([]);

    await pool.query(
      "UPDATE jobs SET run_after = now() WHERE kind = 'webhook-comment'",
    );
    const commentJob = await claimJob(getPool(), "webhook-comment-test", [
      "webhook-comment",
    ]);
    expect(commentJob?.kind).toBe("webhook-comment");
    await runClaimedJob(commentJob!, "webhook-comment-test", "worker");
    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]).toEqual({
      repoFullName: "octo/issues",
      number: 4,
      body: expect.stringContaining("Review commands only work on pull requests."),
    });
    expect(postedComments[0]?.body).toContain("<!-- postil-respond-job:");
  });

  test("approval command rejects head mismatches", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(repoId);
    pullRequestHeadSha = "new-head";

    const res = await approvalComment("approval-head-mismatch");

    expect(res.status).toBe(200);
    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals",
    );
    expect(approvals.rows[0]!.c).toBe(0);
    expect((await queuedWebhookCommentBodies())[0]).toContain("head is new-head");
  });

  test("approval command rejects missing findings", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(repoId);

    const res = await approvalComment("approval-missing", "@postil approve no-such-id -- reviewed");

    expect(res.status).toBe(200);
    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals",
    );
    expect(approvals.rows[0]!.c).toBe(0);
    expect((await queuedWebhookCommentBodies())[0]).toContain("absent");
  });

  test("approval command rejects unverified and non-admin commenters", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedCompletedApprovalReview(repoId);

    expect((await approvalComment("approval-unverified")).status).toBe(200);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain("could not be verified");

    await seedUser(501, "admin", orgId, "member");
    expect((await approvalComment("approval-member")).status).toBe(200);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain(
      "requires an organization admin",
    );

    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals",
    );
    expect(approvals.rows[0]!.c).toBe(0);
  });

  test("approval command rejects severity-blocking findings", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(
      repoId,
      approvalEnvelope({
        findings: [
          {
            id: "kind-blocker",
            path: "src/app.ts",
            line: 10,
            severity: "error",
            kind: "humanEscalation",
            confidence: 0.9,
            title: "Manual approval required",
            body: "The policy escalated this change.",
          },
        ],
        counts: { info: 0, warn: 0, error: 1, suppressed: 0, ungrounded: 0 },
      }),
    );

    const res = await approvalComment("approval-severity");

    expect(res.status).toBe(200);
    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals",
    );
    expect(approvals.rows[0]!.c).toBe(0);
    expect((await queuedWebhookCommentBodies())[0]).toContain("severity-blocking");
  });

  test("approval command rejects previously revoked approvals", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    const userId = await seedUser(501, "admin", orgId, "admin");
    const reviewId = await seedCompletedApprovalReview(repoId);
    await pool.query(
      `INSERT INTO finding_approvals
         (review_id, finding_id, actor_user_id, actor_github_id, actor_login_snapshot,
          actor_role_snapshot, rationale, source, revoked_at, revoked_by_user_id)
       VALUES ($1, 'kind-blocker', $2, '501', 'admin', 'admin', 'revoked earlier', 'dashboard', now(), $2)`,
      [reviewId, userId],
    );

    const res = await approvalComment("approval-revoked");

    expect(res.status).toBe(200);
    const active = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals WHERE revoked_at IS NULL",
    );
    expect(active.rows[0]!.c).toBe(0);
    expect((await queuedWebhookCommentBodies())[0]).toContain("revoked");
  });

  test("approval for an old head does not carry to a new commit review", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    const userId = await seedUser(501, "admin", orgId, "admin");
    const oldReviewId = await seedCompletedApprovalReview(repoId);
    await pool.query(
      `INSERT INTO finding_approvals
         (review_id, finding_id, actor_user_id, actor_github_id, actor_login_snapshot,
          actor_role_snapshot, rationale, source)
       VALUES ($1, 'kind-blocker', $2, '501', 'admin', 'admin', 'approved old head', 'dashboard')`,
      [oldReviewId, userId],
    );
    const newReview = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, envelope, silent,
          engine_gate_failing, gate_failing, gate_check_run_id, finished_at)
       VALUES ($1, 9, 'new-head', 'base-sha', 'completed', $2, false, true, true, 901, now())
       RETURNING id`,
      [
        repoId,
        JSON.stringify(
          approvalEnvelope({
            headSha: "new-head",
          }),
        ),
      ],
    );

    const activeForNew = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals WHERE review_id = $1 AND revoked_at IS NULL",
      [newReview.rows[0]!.id],
    );
    const newGate = await pool.query<{ gate_failing: boolean }>(
      "SELECT gate_failing FROM reviews WHERE id = $1",
      [newReview.rows[0]!.id],
    );
    expect(activeForNew.rows[0]!.c).toBe(0);
    expect(newGate.rows[0]!.gate_failing).toBe(true);
  });

  test("newer completed review guard rejects an older review for the same head", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    const older = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, envelope, silent,
          engine_gate_failing, gate_failing, gate_check_run_id, finished_at)
       VALUES ($1, 9, 'head-sha', 'base-sha', 'completed', $2, false, true, true, 900, now() - interval '1 minute')
       RETURNING id`,
      [repoId, JSON.stringify(approvalEnvelope())],
    );
    await seedCompletedApprovalReview(repoId);

    expect(
      await hasNewerCompletedReviewForHead(getDb(), {
        id: Number(older.rows[0]!.id),
        publicId: "11111111-1111-4111-8111-111111111111",
        repositoryId: repoId,
        prNumber: 9,
        headSha: "head-sha",
        status: "completed",
        envelope: approvalEnvelope() as never,
        engineGateFailing: true,
        gateFailing: true,
        gateCheckRunId: 900,
        repoFullName: "octo/approvals",
        orgId,
        githubInstallationId: 700,
      }),
    ).toBe(true);
  });

  test("approval command commits state before asynchronous gate synchronization", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    const reviewId = await seedCompletedApprovalReview(repoId);
    const res = await approvalComment("approval-check-fails");

    expect(res.status).toBe(200);
    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals WHERE review_id = $1",
      [reviewId],
    );
    expect(approvals.rows[0]!.c).toBe(1);
    const review = await pool.query<{ gate_failing: boolean }>(
      "SELECT gate_failing FROM reviews WHERE id = $1",
      [reviewId],
    );
    expect(review.rows[0]!.gate_failing).toBe(false);
    const syncJobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'gate-state-sync'",
    );
    expect(syncJobs.rows[0]!.c).toBe(1);
    expect(completedCheckRuns).toEqual([]);
    const replies = await queuedWebhookCommentBodies();
    expect(replies[0]).toContain("Approval recorded");
    expect(replies[0]).toContain("gate update is queued");
  });

  function checkRunRerequestedEvent(
    deliveryId: string,
    overrides: {
      installationId?: number;
      repo?: { id: number; full_name: string; private?: boolean };
      name?: string;
      headSha?: string;
      prNumber?: number | null;
      baseSha?: string | null;
    } = {},
  ): Promise<Response> {
    const prNumber = overrides.prNumber === undefined ? 42 : overrides.prNumber;
    return post(
      "check_run",
      {
        action: "rerequested",
        installation: { id: overrides.installationId ?? 500 },
        repository: overrides.repo ?? { id: 5555, full_name: "octo/gate", private: false },
        check_run: {
          name: overrides.name ?? "postil/gate",
          head_sha: overrides.headSha ?? "deadbeef",
          pull_requests:
            prNumber === null
              ? []
              : [
                  {
                    number: prNumber,
                    head: { sha: overrides.headSha ?? "deadbeef" },
                    base: { sha: overrides.baseSha === undefined ? "basesha" : overrides.baseSha },
                  },
                ],
        },
      },
      deliveryId,
    );
  }

  test("check_run rerequested for postil/gate enqueues a review job", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 500);
    await seedRepo(inst, 5555, "octo/gate");

    const res = await checkRunRerequestedEvent("delivery-rerequest-1");
    expect(res.status).toBe(200);

    const jobs = await pool.query<{ payload: { prNumber: number; headSha: string } }>(
      "SELECT payload FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload.prNumber).toBe(42);
    expect(jobs.rows[0]!.payload.headSha).toBe("deadbeef");
  });

  test("check_run rerequested for an unknown/disabled repo is skipped", async () => {
    // No org/installation/repo seeded at all: installation lookup fails closed.
    const res = await checkRunRerequestedEvent("delivery-rerequest-unknown");
    expect(res.status).toBe(200);

    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]!.c).toBe(0);
  });

  test("check_run rerequested does not double-enqueue over an in-flight review job", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 500);
    await seedRepo(inst, 5555, "octo/gate");

    // Simultaneous deliveries for different check names must contend on the
    // database constraint rather than both passing an application-side check.
    const [first, second] = await Promise.all([
      checkRunRerequestedEvent("delivery-rerequest-dup-1"),
      checkRunRerequestedEvent("delivery-rerequest-dup-2", {
        name: "postil/review",
      }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]!.c).toBe(1);
  });
});
