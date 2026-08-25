import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Pool } from "pg";

import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";
import { getSealingKey, seal } from "@/lib/crypto/seal";
import type { PullRequestReviewContext } from "@/lib/github/checks";
import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  signWebhookBody,
} from "@/lib/crypto/webhook";
import {
  activateHostedInferenceRelease,
  deactivateHostedInferenceRelease,
} from "@/lib/release-job-rollout";

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
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;

// Record check-run completions the removal path drives, and hand back a fake
// installation token so no real GitHub App credentials are needed. Spread the
// real module: other importers use its remaining exports, and a bare override
// object would break their import chains.
const completedCheckRuns: Array<{
  repoFullName: string;
  conclusion: string;
  detailsUrl?: string;
}> = [];
const postedComments: Array<{ repoFullName: string; number: number; body: string }> = [];
const addedReactions: Array<{ repoFullName: string; commentId: number; kind: string }> = [];
let pullRequestHeadSha = "head-sha";
let liveMembershipStatus = 200;
let liveMembershipRole: "admin" | "member" = "admin";
let liveMembershipState = "active";
let liveMembershipUserId = 501;
let liveMembershipUserLogin = "admin";
let liveMembershipOrgId = 999;
let liveMembershipOrgLogin = "octo";
let membershipFetchCount = 0;
let pullRequestReviewContextFetchCount = 0;
let pullRequestReviewContext: PullRequestReviewContext = {
  open: true,
  merged: false,
  headSha: "head-sha",
  baseSha: "base-sha",
  draft: false,
  authorGithubId: 501,
  authorLogin: "admin",
  updatedAt: "2026-08-24T12:34:56Z",
};
let reviewCommentRoot = {
  id: 8800,
  body: "The nullable branch can return before this check.",
  userLogin: "postil-dev[bot]",
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
  addCommentReaction: async (
    _token: string,
    repoFullName: string,
    commentId: number,
    kind: string,
  ) => {
    addedReactions.push({ repoFullName, commentId, kind });
    return "created" as const;
  },
  completeCheckRun: async (
    _token: string,
    repoFullName: string,
    _id: number,
    conclusion: string,
    _title: string,
    _summary: string,
    _signal?: AbortSignal,
    detailsUrl?: string,
  ) => {
    completedCheckRuns.push({
      repoFullName,
      conclusion,
      ...(detailsUrl ? { detailsUrl } : {}),
    });
  },
  getPullRequestHeadSha: async () => pullRequestHeadSha,
  getPullRequestReviewContext: async () => {
    pullRequestReviewContextFetchCount += 1;
    return pullRequestReviewContext;
  },
  getPullRequestReviewComment: async () => reviewCommentRoot,
  findIssueCommentByMarker: async () => null,
  postIssueComment: async (_token: string, repoFullName: string, number: number, body: string) => {
    postedComments.push({ repoFullName, number, body });
    return 123;
  },
}));

// Imported after the mocks are registered so the route picks up the stubs.
const { POST } = await import("@/app/api/webhooks/github/route");
const { getDb, getPool, closeDb } = await import("@/lib/db");
const { hasNewerCompletedReviewForHead } = await import("@/lib/finding-approvals");
const {
  reconcileOperatorAlertDeliveries,
  sweepExpiredSelfServiceTrials,
} = await import("@/lib/operator-alerts");
const { claimJob } = await import("@/lib/queue");
const { runClaimedJob } = await import("@/worker/runner");

async function accept(event: string, body: object, deliveryId: string): Promise<Response> {
  const raw = JSON.stringify(body);
  return POST(
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
}

async function post(event: string, body: object, deliveryId: string): Promise<Response> {
  const response = await accept(event, body, deliveryId);
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
  let db: EphemeralDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createEphemeralDatabase("webhook_handlers");
    pool = db.pool;
    // The webhook route and worker runner reach the database through the
    // getDb()/getPool() singleton, keyed off DATABASE_URL.
    process.env.DATABASE_URL = db.url;
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "0";
    process.env.POSTIL_SEALING_KEY = "cd".repeat(32);
  }, 30_000);

  beforeEach(async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    completedCheckRuns.length = 0;
    postedComments.length = 0;
    addedReactions.length = 0;
    pullRequestHeadSha = "head-sha";
    liveMembershipStatus = 200;
    liveMembershipRole = "admin";
    liveMembershipState = "active";
    liveMembershipUserId = 501;
    liveMembershipUserLogin = "admin";
    liveMembershipOrgId = 999;
    liveMembershipOrgLogin = "octo";
    membershipFetchCount = 0;
    pullRequestReviewContextFetchCount = 0;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/repos/octo/approvals")) {
          return Response.json({
            id: 7000,
            full_name: "octo/approvals",
            private: false,
            owner: { id: 7001, login: "octo" },
          });
        }
        if (url.includes("/repos/octo/issues")) {
          return Response.json({
            id: 7001,
            full_name: "octo/issues",
            private: false,
            owner: { id: 7002, login: "octo" },
          });
        }
        if (!url.includes("/orgs/octo/memberships/admin")) {
          throw new Error(`unexpected GitHub request: ${url}`);
        }
        membershipFetchCount += 1;
        return new Response(
          liveMembershipStatus === 200
            ? JSON.stringify({
                state: liveMembershipState,
                role: liveMembershipRole,
                user: { id: liveMembershipUserId, login: liveMembershipUserLogin },
                organization: { id: liveMembershipOrgId, login: liveMembershipOrgLogin },
              })
            : "unavailable",
          {
            status: liveMembershipStatus,
            headers: { "content-type": "application/json" },
          },
        );
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    pullRequestReviewContext = {
      open: true,
      merged: false,
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
      authorGithubId: 501,
      authorLogin: "admin",
      updatedAt: "2026-08-24T12:34:56Z",
    };
    reviewCommentRoot = {
      id: 8800,
      body: "The nullable branch can return before this check.",
      userLogin: "postil-dev[bot]",
    };
    delete process.env.POSTIL_RESPOND_HOURLY_CAP;
    delete process.env.POSTIL_HOSTED_INFERENCE_ENABLED;
    delete process.env.POSTIL_RELEASE_SHA;
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.com";
    await pool.query(
      "TRUNCATE private_worker_rehearsals, respond_deliveries, jobs RESTART IDENTITY",
    );
    await pool.query("TRUNCATE webhook_deliveries");
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE 'hosted-inference-%'",
    );
    await pool.query(
      "TRUNCATE self_service_trial_grants, reviews, repositories, installations, organizations, users RESTART IDENTITY CASCADE",
    );
  }, 30_000);

  afterAll(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.POSTIL_PUBLIC_URL;
    else process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
    // Release the getDb()/getPool() singleton's connection before dropping
    // the database it points at, or the drop fails with "database is being
    // accessed by other users".
    await closeDb();
    await db?.drop();
  }, 30_000);

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

  async function seedInstallation(
    orgId: number,
    githubInstallationId: number,
    accountType = "Organization",
  ): Promise<number> {
    const inst = await pool.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, org_id, account_login, account_type, suspended)
       VALUES ($1, $2, 'octo', $3, false) RETURNING id`,
      [githubInstallationId, orgId, accountType],
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

  async function runPendingWebhookDispatch(
    deliveryId: string,
    workerId: string,
  ): Promise<void> {
    await pool.query(
      `UPDATE jobs
          SET run_after = now()
        WHERE kind = 'webhook-dispatch'
          AND payload->>'deliveryId' = $1`,
      [deliveryId],
    );
    const job = await claimJob(pool, workerId, ["webhook-dispatch"]);
    expect(job?.kind).toBe("webhook-dispatch");
    await runClaimedJob(job!, workerId, "web");
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
    liveMembershipRole = role;
    const ciphertext = seal("approval-oauth-token", getSealingKey());
    await pool.query(
      `INSERT INTO sessions
         (id, user_id, expires_at, github_access_token_ciphertext, membership_checked_at)
       VALUES ($1, $2, now() + interval '1 hour', $3, now())
       ON CONFLICT (id) DO UPDATE SET
         user_id = excluded.user_id,
         expires_at = excluded.expires_at,
         github_access_token_ciphertext = excluded.github_access_token_ciphertext,
         membership_checked_at = excluded.membership_checked_at`,
      [`approval-session-${userId}`, userId, ciphertext],
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
         (repository_id, source_org_id, source_installation_id,
          source_github_installation_id, source_github_repo_id, source_repo_full_name,
          pr_number, head_sha, base_sha, status, envelope, silent,
          engine_gate_failing, gate_failing, gate_check_run_id, finished_at)
       SELECT repository.id, installation.org_id, installation.id,
              installation.github_installation_id, repository.github_repo_id, repository.full_name,
              9, 'head-sha', 'base-sha', 'completed', $2, false, true, true, 900, now()
       FROM repositories repository
       JOIN installations installation ON installation.id = repository.installation_id
       WHERE repository.id = $1
       RETURNING id`,
      [repoId, JSON.stringify(envelope)],
    );
    return Number(row.rows[0]!.id);
  }

  function approvalComment(
    deliveryId: string,
    body = "@postil approve kind-blocker -- reviewed",
    privateRepository = false,
    repoFullName = "octo/approvals",
  ): Promise<Response> {
    return post(
      "issue_comment",
      {
        action: "created",
        installation: { id: 700 },
        repository: { id: 7000, full_name: repoFullName, private: privateRepository },
        sender: { id: 501, login: "admin", type: "User" },
        comment: {
          id: 123456,
          html_url: `https://github.com/${repoFullName}/pull/9#issuecomment-123456`,
          body,
          user: { id: 501, login: "admin", type: "User" },
          author_association: "MEMBER",
        },
        issue: { number: 9, pull_request: {} },
      },
      deliveryId,
    );
  }

  function dismissalComment(
    deliveryId: string,
    body = "@postil dismiss kind-blocker -- false-positive: the guard is unreachable",
  ): Promise<Response> {
    return approvalComment(deliveryId, body);
  }

  test("pull_request upsert re-pins a repo transferred between installations", async () => {
    const orgId = await seedOrg();
    const oldInst = await seedInstallation(orgId, 100);
    const newInst = await seedInstallation(orgId, 200);
    // Repo currently owned by the old installation.
    await seedRepo(oldInst, 7777, "octo/repo");
    pullRequestReviewContext = {
      ...pullRequestReviewContext,
      headSha: "h",
      baseSha: "b",
    };

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
      payload: {
        authorGithubId: number;
        authorLogin: string;
        trigger: Record<string, unknown>;
      };
    }>(
      "SELECT payload FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload).toMatchObject({
      authorGithubId: 4242,
      authorLogin: "dependabot[bot]",
      trigger: {
        source: "automatic_pull_request",
        webhookDeliveryId: "delivery-transfer-1",
        webhookEvent: "pull_request",
        webhookAction: "opened",
      },
    });
  });

  test("installation grants one owner-scoped trial and reinstall cannot reset it", async () => {
    const account = { id: 9090, login: "NewCustomer", type: "Organization" };
    const created = {
      action: "created",
      installation: { id: 8080, account, suspended_at: null },
      repositories: [],
      sender: { id: 7001, login: "installer", type: "User" },
    };

    expect((await post("installation", created, "trial-created-1")).status).toBe(200);

    const first = await pool.query<{
      org_id: string;
      status: string;
      subscription_mode: string;
      trial_ends_at: Date;
      period_starts_at: Date;
      period_ends_at: Date;
      included_usage_micros: string;
    }>(
      `SELECT org_id, status, subscription_mode, trial_ends_at, period_starts_at,
              period_ends_at, included_usage_micros
         FROM organization_entitlements`,
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      status: "trialing",
      subscription_mode: "hosted",
      included_usage_micros: "100000000",
    });
    expect(first.rows[0]!.trial_ends_at.getTime() - first.rows[0]!.period_starts_at.getTime())
      .toBe(30 * 24 * 60 * 60 * 1_000);
    expect(first.rows[0]!.period_ends_at).toEqual(first.rows[0]!.trial_ends_at);

    const alerts = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM jobs WHERE kind = 'operator-alert'",
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]!.payload).toMatchObject({
      event: "trial_started",
      orgSlug: "newcustomer",
      accountLogin: "NewCustomer",
      githubOwnerId: 9090,
      githubInstallationId: 8080,
    });

    expect((await post("installation", {
      action: "deleted",
      installation: { id: 8080, account },
    }, "trial-deleted-1")).status).toBe(200);
    expect((await post("installation", {
      ...created,
      installation: { id: 8081, account, suspended_at: null },
    }, "trial-created-2")).status).toBe(200);

    const afterReinstall = await pool.query<{
      trial_ends_at: Date;
      alert_count: number;
      removal_alert_count: number;
    }>(
      `SELECT entitlement.trial_ends_at,
              (SELECT count(*)::int FROM jobs
                WHERE kind = 'operator-alert' AND payload ->> 'event' = 'trial_started') AS alert_count,
              (SELECT count(*)::int FROM jobs
                WHERE kind = 'operator-alert' AND payload ->> 'event' = 'installation_removed') AS removal_alert_count
         FROM organization_entitlements entitlement`,
    );
    expect(afterReinstall.rows).toHaveLength(1);
    expect(afterReinstall.rows[0]!.trial_ends_at).toEqual(first.rows[0]!.trial_ends_at);
    expect(afterReinstall.rows[0]!.alert_count).toBe(1);
    expect(afterReinstall.rows[0]!.removal_alert_count).toBe(1);
  });

  test("every account an actor installs receives its own hosted trial", async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const account = {
          id: 9200 + index,
          login: `TrialOwner${index}`,
          type: "Organization",
        };
        return post("installation", {
          action: "created",
          installation: { id: 8200 + index, account, suspended_at: null },
          repositories: [],
          sender: { id: 777, login: "installer", type: "User" },
        }, `trial-cross-owner-${index}`);
      }),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);

    const grants = await pool.query<{
      requested_mode: string;
      granted_mode: string;
      initiated_by_github_id: string;
    }>(
      `SELECT requested_mode, granted_mode, initiated_by_github_id
         FROM self_service_trial_grants
        WHERE initiated_by_github_id = 777
        ORDER BY created_at, org_id`,
    );
    expect(grants.rows).toHaveLength(4);
    expect(grants.rows.map((row) => row.requested_mode)).toEqual([
      "hosted", "hosted", "hosted", "hosted",
    ]);
    expect(grants.rows.map((row) => row.granted_mode)).toEqual([
      "hosted", "hosted", "hosted", "hosted",
    ]);
  });

  test("installation without a verified sender defers its trial until authenticated setup", async () => {
    const account = {
      id: 9250,
      login: "UnsignedTrialOwner",
      type: "Organization",
    };
    expect((await post("installation", {
      action: "created",
      installation: { id: 8250, account, suspended_at: null },
      repositories: [],
    }, "trial-missing-sender")).status).toBe(200);

    const grants = await pool.query<{
      requested_mode: string;
      granted_mode: string;
      initiated_by_github_id: string;
    }>(
      `SELECT requested_mode, granted_mode, initiated_by_github_id
         FROM self_service_trial_grants
        WHERE org_id = (SELECT id FROM organizations WHERE github_org_id = 9250)`,
    );
    expect(grants.rows).toEqual([]);
  });

  test("installation during a dark release is promoted when that exact release activates", async () => {
    const releaseSha = "dddddddddddddddddddddddddddddddddddddddd";
    process.env.POSTIL_RELEASE_SHA = releaseSha;
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    const account = { id: 9260, login: "DarkTrialOwner", type: "Organization" };
    const installation = {
      action: "created",
      installation: { id: 8260, account, suspended_at: null },
      repositories: [],
      sender: { id: 778, login: "installer", type: "User" },
    };
    expect((await post("installation", installation, "trial-dark-created")).status)
      .toBe(200);
    expect((await pool.query<{ requested_mode: string; granted_mode: string; subscription_mode: string }>(`
      SELECT trial.requested_mode, trial.granted_mode, entitlement.subscription_mode
      FROM self_service_trial_grants trial
      JOIN organization_entitlements entitlement ON entitlement.org_id = trial.org_id
    `)).rows[0]).toEqual({
      requested_mode: "hosted",
      granted_mode: "byok",
      subscription_mode: "byok",
    });

    expect(await activateHostedInferenceRelease(pool, releaseSha)).toBe(true);
    expect((await pool.query<{ granted_mode: string; subscription_mode: string }>(`
      SELECT trial.granted_mode, entitlement.subscription_mode
      FROM self_service_trial_grants trial
      JOIN organization_entitlements entitlement ON entitlement.org_id = trial.org_id
    `)).rows[0]).toEqual({
      granted_mode: "hosted",
      subscription_mode: "hosted",
    });
    expect((await post("installation", installation, "trial-dark-reinstall")).status)
      .toBe(200);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM self_service_trial_grants",
    )).rows[0]!.count).toBe(1);
  });

  test("installation racing exact release activation always receives hosted access", async () => {
    const releaseSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    process.env.POSTIL_RELEASE_SHA = releaseSha;
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    const account = { id: 9270, login: "RacingTrialOwner", type: "Organization" };
    const [response] = await Promise.all([
      post("installation", {
        action: "created",
        installation: { id: 8270, account, suspended_at: null },
        repositories: [],
        sender: { id: 779, login: "installer", type: "User" },
      }, "trial-racing-created"),
      activateHostedInferenceRelease(pool, releaseSha),
    ]);
    expect(response.status).toBe(200);
    expect((await pool.query<{ granted_mode: string; subscription_mode: string }>(`
      SELECT trial.granted_mode, entitlement.subscription_mode
      FROM self_service_trial_grants trial
      JOIN organization_entitlements entitlement ON entitlement.org_id = trial.org_id
    `)).rows[0]).toEqual({
      granted_mode: "hosted",
      subscription_mode: "hosted",
    });
  });

  test("suspended installation waits to grant its trial until unsuspended", async () => {
    const account = { id: 9191, login: "PausedCustomer", type: "Organization" };
    expect((await post("installation", {
      action: "created",
      installation: { id: 8181, account, suspended_at: "2026-07-18T00:00:00Z" },
      repositories: [],
    }, "trial-suspended-created")).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM organization_entitlements")).rowCount).toBe(0);

    expect((await post("installation", {
      action: "unsuspend",
      installation: { id: 8181, account, suspended_at: null },
      sender: { id: 7002, login: "installer", type: "User" },
    }, "trial-unsuspended")).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM organization_entitlements")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM jobs WHERE kind = 'operator-alert'")).rowCount).toBe(1);

    expect((await post("installation", {
      action: "suspend",
      installation: { id: 8181, account, suspended_at: "2026-07-18T01:00:00Z" },
    }, "trial-suspended-again")).status).toBe(200);
    expect((await post("installation", {
      action: "suspend",
      installation: { id: 8181, account, suspended_at: "2026-07-18T01:00:00Z" },
    }, "trial-suspended-repeat")).status).toBe(200);
    expect((await post("installation", {
      action: "unsuspend",
      installation: { id: 8181, account, suspended_at: null },
      sender: { id: 7002, login: "installer", type: "User" },
    }, "trial-restored-again")).status).toBe(200);
    expect((await post("installation", {
      action: "deleted",
      installation: { id: 8181, account },
    }, "trial-installation-removed")).status).toBe(200);

    const notifications = await pool.query<{
      idempotency_key: string;
      category: string;
      visibility: string;
    }>(
      `SELECT idempotency_key, category, visibility
         FROM customer_notification_events
        WHERE org_id = (SELECT id FROM organizations WHERE github_org_id = $1)
          AND category = 'security'
        ORDER BY id`,
      [account.id],
    );
    expect(notifications.rows).toEqual([
      {
        idempotency_key: "installation-restored:8181:trial-unsuspended",
        category: "security",
        visibility: "admins",
      },
      {
        idempotency_key: "installation-suspended:8181:trial-suspended-again",
        category: "security",
        visibility: "admins",
      },
      {
        idempotency_key: "installation-restored:8181:trial-restored-again",
        category: "security",
        visibility: "admins",
      },
      {
        idempotency_key: "installation-removed:8181:trial-installation-removed",
        category: "security",
        visibility: "admins",
      },
    ]);
    expect((await post("installation", {
      action: "suspend",
      installation: { id: 8181, account, suspended_at: "2026-07-18T02:00:00Z" },
    }, "trial-suspended-after-removal")).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM installations")).rowCount).toBe(0);
  });

  test("hosted pause starts a BYOK trial without consuming hosted inference", async () => {
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    expect((await post("installation", {
      action: "created",
      installation: {
        id: 8282,
        account: { id: 9292, login: "WaitingCustomer", type: "Organization" },
        suspended_at: null,
      },
      repositories: [],
      sender: { id: 7003, login: "installer", type: "User" },
    }, "trial-hosted-paused")).status).toBe(200);
    const entitlement = await pool.query<{ subscription_mode: string }>(
      "SELECT subscription_mode FROM organization_entitlements",
    );
    expect(entitlement.rows).toEqual([{ subscription_mode: "byok" }]);
    expect((await pool.query("SELECT 1 FROM jobs WHERE kind = 'operator-alert'")).rowCount).toBe(1);
  });

  test("expired trials transition once and queue one audited owner alert", async () => {
    const orgId = await seedOrg();
    const trialEndsAt = new Date("2026-07-18T11:00:00.000Z");
    await pool.query(
      `INSERT INTO organization_entitlements
         (org_id, subscription_mode, status, trial_ends_at, period_starts_at,
          period_ends_at, updated_by)
       VALUES ($1, 'byok', 'trialing', $2::timestamptz,
               $2::timestamptz - interval '30 days', $2::timestamptz,
               'self-service-trial')`,
      [orgId, trialEndsAt],
    );

    const now = new Date("2026-07-18T12:00:00.000Z");
    const [first, concurrent] = await Promise.all([
      sweepExpiredSelfServiceTrials(getDb(), now),
      sweepExpiredSelfServiceTrials(getDb(), now),
    ]);
    expect(first.transitioned + concurrent.transitioned).toBe(1);
    expect(first.alerted + concurrent.alerted).toBe(1);

    const state = await pool.query<{
      status: string;
      updated_by: string;
      job_count: number;
      audit_count: number;
    }>(
      `SELECT entitlement.status, entitlement.updated_by,
              (SELECT count(*)::int FROM jobs
                WHERE kind = 'operator-alert' AND payload ->> 'event' = 'trial_expired') AS job_count,
              (SELECT count(*)::int FROM operator_alert_deliveries
                WHERE event = 'trial_expired' AND status = 'queued') AS audit_count
         FROM organization_entitlements entitlement
        WHERE entitlement.org_id = $1`,
      [orgId],
    );
    expect(state.rows[0]).toMatchObject({
      status: "past_due",
      updated_by: "self-service-trial-expiry",
      job_count: 1,
      audit_count: 1,
    });
    expect(await sweepExpiredSelfServiceTrials(getDb(), now)).toEqual({
      transitioned: 0,
      alerted: 0,
    });

    await pool.query(
      `UPDATE jobs SET status = 'done'
       WHERE kind = 'operator-alert' AND payload ->> 'event' = 'trial_expired'`,
    );
    await reconcileOperatorAlertDeliveries(getDb());
    const delivered = await pool.query<{ status: string; delivered_at: Date | null }>(
      `SELECT status, delivered_at FROM operator_alert_deliveries
       WHERE event = 'trial_expired'`,
    );
    expect(delivered.rows[0]?.status).toBe("delivered");
    expect(delivered.rows[0]?.delivered_at).toBeInstanceOf(Date);
  });

  test("trial setup does not enqueue email when operator alerts are not configured", async () => {
    delete process.env.POSTIL_OPERATOR_ALERT_EMAIL;
    expect((await post("installation", {
      action: "created",
      installation: {
        id: 8383,
        account: { id: 9393, login: "SelfHostedCustomer", type: "Organization" },
        suspended_at: null,
      },
      repositories: [],
      sender: { id: 7004, login: "installer", type: "User" },
    }, "trial-without-operator-alerts")).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM organization_entitlements")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM jobs WHERE kind = 'operator-alert'")).rowCount).toBe(0);
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
    pullRequestReviewContext = {
      ...pullRequestReviewContext,
      headSha: "new-head",
      baseSha: "base",
    };

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
    expect(
      completedCheckRuns.map(({ repoFullName, conclusion }) => ({
        repoFullName,
        conclusion,
      })),
    ).toEqual([
      { repoFullName: "octo/repo", conclusion: "neutral" },
      { repoFullName: "octo/repo", conclusion: "neutral" },
    ]);
    const jobs = await pool.query<{ payload: { headSha: string } }>(
      "SELECT payload FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload.headSha).toBe("new-head");
  });

  test("pull request description edits enqueue a full same-head review", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 251);
    await seedRepo(inst, 7879, "octo/metadata");
    pullRequestReviewContext = {
      ...pullRequestReviewContext,
      headSha: "same-head",
      baseSha: "base",
    };

    const res = await post(
      "pull_request",
      {
        action: "edited",
        installation: { id: 251 },
        repository: { id: 7879, full_name: "octo/metadata", private: false },
        pull_request: {
          number: 8,
          head: { sha: "same-head" },
          base: { sha: "base" },
        },
      },
      "delivery-edit-1",
    );

    expect(res.status).toBe(200);
    const jobs = await pool.query<{
      payload: { forceFullReview?: boolean; sourceDeliveryId?: string };
    }>("SELECT payload FROM jobs WHERE kind = 'review'");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.payload).toMatchObject({
      forceFullReview: true,
      sourceDeliveryId: "delivery-edit-1",
    });
  });

  test("a newer reopened event retries until the live action converges", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 252);
    await seedRepo(inst, 7880, "octo/reopened");
    pullRequestReviewContext = {
      open: false,
      merged: false,
      headSha: "same-head",
      baseSha: "base",
      draft: false,
      updatedAt: "2026-08-24T12:34:55Z",
    };

    const response = await post(
      "pull_request",
      {
        action: "reopened",
        installation: { id: 252 },
        repository: { id: 7880, full_name: "octo/reopened", private: false },
        pull_request: {
          number: 9,
          head: { sha: "same-head" },
          base: { sha: "base" },
          updated_at: "2026-08-24T12:34:56Z",
        },
      },
      "delivery-reopened-lagging",
    );

    expect(response.status).toBe(200);
    const deferred = await pool.query<{
      deliveryCompleted: boolean;
      dispatchStatus: string;
      attempts: number;
      reviewJobs: number;
    }>(
      `SELECT delivery.completed_at IS NOT NULL AS "deliveryCompleted",
              dispatch.status AS "dispatchStatus",
              dispatch.attempts,
              (SELECT count(*)::int FROM jobs WHERE kind = 'review') AS "reviewJobs"
         FROM webhook_deliveries delivery
         JOIN jobs dispatch
           ON dispatch.kind = 'webhook-dispatch'
          AND dispatch.payload->>'deliveryId' = delivery.delivery_id
        WHERE delivery.delivery_id = 'delivery-reopened-lagging'`,
    );
    expect(deferred.rows[0]).toEqual({
      deliveryCompleted: false,
      dispatchStatus: "queued",
      attempts: 1,
      reviewJobs: 0,
    });

    pullRequestReviewContext = {
      ...pullRequestReviewContext,
      open: true,
      updatedAt: "2026-08-24T12:34:56Z",
    };
    await runPendingWebhookDispatch(
      "delivery-reopened-lagging",
      "webhook-reopened-retry",
    );

    const completed = await pool.query<{
      deliveryCompleted: boolean;
      dispatchStatus: string;
      reviewStatus: string;
      forceFullReview: boolean;
    }>(
      `SELECT delivery.completed_at IS NOT NULL AS "deliveryCompleted",
              dispatch.status AS "dispatchStatus",
              review.status AS "reviewStatus",
              (review.payload->>'forceFullReview')::boolean AS "forceFullReview"
         FROM webhook_deliveries delivery
         JOIN jobs dispatch
           ON dispatch.kind = 'webhook-dispatch'
          AND dispatch.payload->>'deliveryId' = delivery.delivery_id
         JOIN jobs review
           ON review.kind = 'review'
          AND review.payload->>'sourceDeliveryId' = delivery.delivery_id
        WHERE delivery.delivery_id = 'delivery-reopened-lagging'`,
    );
    expect(completed.rows[0]).toEqual({
      deliveryCompleted: true,
      dispatchStatus: "done",
      reviewStatus: "queued",
      forceFullReview: true,
    });
  });

  test("an older closed event preserves the newer live pull request", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 253);
    const repoId = await seedRepo(inst, 7881, "octo/stale-close");
    await pool.query(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, queued_at, started_at)
       VALUES ($1, 10, 'same-head', 'base', 'running', now(), now())`,
      [repoId],
    );
    pullRequestReviewContext = {
      open: true,
      merged: false,
      headSha: "same-head",
      baseSha: "base",
      draft: false,
      updatedAt: "2026-08-24T12:34:56Z",
    };

    expect(
      (
        await post(
          "pull_request",
          {
            action: "closed",
            installation: { id: 253 },
            repository: { id: 7881, full_name: "octo/stale-close", private: false },
            pull_request: {
              number: 10,
              head: { sha: "same-head" },
              base: { sha: "base" },
              updated_at: "2026-08-24T12:34:55Z",
            },
          },
          "delivery-stale-close",
        )
      ).status,
    ).toBe(200);

    const state = await pool.query<{
      deliveryCompleted: boolean;
      dispatchStatus: string;
      reviewStatus: string;
      reviewJobs: number;
    }>(
      `SELECT delivery.completed_at IS NOT NULL AS "deliveryCompleted",
              dispatch.status AS "dispatchStatus",
              (SELECT status FROM reviews WHERE repository_id = $1) AS "reviewStatus",
              (SELECT count(*)::int FROM jobs WHERE kind = 'review') AS "reviewJobs"
         FROM webhook_deliveries delivery
         JOIN jobs dispatch
           ON dispatch.kind = 'webhook-dispatch'
          AND dispatch.payload->>'deliveryId' = delivery.delivery_id
        WHERE delivery.delivery_id = 'delivery-stale-close'`,
      [repoId],
    );
    expect(state.rows[0]).toEqual({
      deliveryCompleted: true,
      dispatchStatus: "done",
      reviewStatus: "running",
      reviewJobs: 0,
    });
    expect(completedCheckRuns).toEqual([]);
  });

  test("an equal contradictory close completes as ignored after 30s and 60s retries", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 254);
    const repoId = await seedRepo(inst, 7882, "octo/equal-state");
    await pool.query(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, queued_at, started_at)
       VALUES ($1, 11, 'same-head', 'base', 'running', now(), now())`,
      [repoId],
    );
    const respond = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload)
       VALUES ('respond', $1::jsonb) RETURNING id`,
      [JSON.stringify({
        installationId: 254,
        sourceInstallationId: inst,
        sourceOrgId: orgId,
        githubRepoId: 7882,
        repoFullName: "octo/equal-state",
        number: 11,
        isPr: true,
        sourceHeadSha: "same-head",
      })],
    );
    await pool.query(
      `INSERT INTO respond_deliveries
         (job_id, repository_id, source_org_id, source_installation_id,
          source_github_installation_id, source_github_repo_id, repo_full_name,
          issue_number, is_pr, source_head_sha, body)
       VALUES ($1, $2, $3, $4, 254, 7882, 'octo/equal-state', 11, true,
               'same-head', 'queued reply')`,
      [respond.rows[0]!.id, repoId, orgId, inst],
    );
    const repositoryVersion = await pool.query<{ version: string }>(
      "SELECT xmin::text AS version FROM repositories WHERE id = $1",
      [repoId],
    );
    pullRequestReviewContext = {
      open: true,
      merged: false,
      headSha: "same-head",
      baseSha: "base",
      draft: false,
      updatedAt: "2026-08-24T12:34:56.100Z",
    };

    expect(
      (
        await accept(
          "pull_request",
          {
            action: "closed",
            installation: { id: 254 },
            repository: { id: 7882, full_name: "octo/equal-state", private: false },
            pull_request: {
              number: 11,
              head: { sha: "same-head" },
              base: { sha: "base" },
              updated_at: "2026-08-24T12:34:56.900Z",
            },
          },
          "delivery-equal-state",
        )
      ).status,
    ).toBe(200);

    await pool.query(
      `UPDATE jobs
          SET created_at = now() - interval '2 hours'
        WHERE kind = 'webhook-dispatch'
          AND payload->>'deliveryId' = 'delivery-equal-state'`,
    );
    await runPendingWebhookDispatch("delivery-equal-state", "webhook-equal-first");

    let state = await pool.query<{
      status: string;
      attempts: number;
      completed: boolean;
      delayMs: number;
      lastError: string | null;
    }>(
      `SELECT dispatch.status, dispatch.attempts,
              delivery.completed_at IS NOT NULL AS completed,
              round(extract(epoch FROM (dispatch.run_after - clock_timestamp())) * 1000)::int
                AS "delayMs",
              dispatch.last_error AS "lastError"
         FROM jobs dispatch
         JOIN webhook_deliveries delivery
           ON delivery.delivery_id = dispatch.payload->>'deliveryId'
        WHERE dispatch.kind = 'webhook-dispatch'
          AND delivery.delivery_id = 'delivery-equal-state'`,
    );
    expect(state.rows[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      completed: false,
      lastError: "GitHub pull request octo/equal-state#11 has not converged for closed",
    });
    expect(state.rows[0]!.delayMs).toBeGreaterThanOrEqual(28_000);
    expect(state.rows[0]!.delayMs).toBeLessThanOrEqual(30_000);

    await runPendingWebhookDispatch("delivery-equal-state", "webhook-equal-second");
    state = await pool.query<{
      status: string;
      attempts: number;
      completed: boolean;
      delayMs: number;
      lastError: string | null;
    }>(
      `SELECT dispatch.status, dispatch.attempts,
              delivery.completed_at IS NOT NULL AS completed,
              round(extract(epoch FROM (dispatch.run_after - clock_timestamp())) * 1000)::int
                AS "delayMs",
              dispatch.last_error AS "lastError"
         FROM jobs dispatch
         JOIN webhook_deliveries delivery
           ON delivery.delivery_id = dispatch.payload->>'deliveryId'
        WHERE dispatch.kind = 'webhook-dispatch'
          AND delivery.delivery_id = 'delivery-equal-state'`,
    );
    expect(state.rows[0]).toMatchObject({
      status: "queued",
      attempts: 2,
      completed: false,
      lastError: "GitHub pull request octo/equal-state#11 has not converged for closed",
    });
    expect(state.rows[0]!.delayMs).toBeGreaterThanOrEqual(58_000);
    expect(state.rows[0]!.delayMs).toBeLessThanOrEqual(60_000);

    await runPendingWebhookDispatch("delivery-equal-state", "webhook-equal-terminal");
    state = await pool.query<{
      status: string;
      attempts: number;
      completed: boolean;
      delayMs: number;
      lastError: string | null;
    }>(
      `SELECT dispatch.status, dispatch.attempts,
              delivery.completed_at IS NOT NULL AS completed,
              round(extract(epoch FROM (dispatch.run_after - clock_timestamp())) * 1000)::int
                AS "delayMs",
              dispatch.last_error AS "lastError"
         FROM jobs dispatch
         JOIN webhook_deliveries delivery
           ON delivery.delivery_id = dispatch.payload->>'deliveryId'
        WHERE dispatch.kind = 'webhook-dispatch'
          AND delivery.delivery_id = 'delivery-equal-state'`,
    );
    expect(state.rows[0]).toMatchObject({
      status: "done",
      attempts: 3,
      completed: true,
      lastError: null,
    });
    expect(pullRequestReviewContextFetchCount).toBe(3);
    const sideEffects = await pool.query<{
      repositoryVersion: string;
      reviewStatus: string;
      reviewFinished: boolean;
      respondStatus: string;
      deliveryState: string;
      reviewJobs: number;
    }>(
      `SELECT
         (SELECT xmin::text FROM repositories WHERE id = $1) AS "repositoryVersion",
         (SELECT status FROM reviews WHERE repository_id = $1) AS "reviewStatus",
         (SELECT finished_at IS NOT NULL FROM reviews WHERE repository_id = $1)
           AS "reviewFinished",
         (SELECT status FROM jobs WHERE id = $2) AS "respondStatus",
         (SELECT state FROM respond_deliveries WHERE job_id = $2) AS "deliveryState",
         (SELECT count(*)::int FROM jobs WHERE kind = 'review') AS "reviewJobs"`,
      [repoId, respond.rows[0]!.id],
    );
    expect(sideEffects.rows[0]).toEqual({
      repositoryVersion: repositoryVersion.rows[0]!.version,
      reviewStatus: "running",
      reviewFinished: false,
      respondStatus: "queued",
      deliveryState: "prepared",
      reviewJobs: 0,
    });
    expect(completedCheckRuns).toEqual([]);
  });

  test("a newer event timestamp does not delay an already converged event", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 255);
    await seedRepo(inst, 7883, "octo/converged");
    pullRequestReviewContext = {
      open: true,
      merged: false,
      headSha: "same-head",
      baseSha: "base",
      draft: false,
      updatedAt: "2026-08-24T12:34:56Z",
    };

    expect(
      (
        await post(
          "pull_request",
          {
            action: "opened",
            installation: { id: 255 },
            repository: { id: 7883, full_name: "octo/converged", private: false },
            pull_request: {
              number: 12,
              head: { sha: "same-head" },
              base: { sha: "base" },
              updated_at: "2026-08-24T12:34:57Z",
            },
          },
          "delivery-converged",
        )
      ).status,
    ).toBe(200);

    const result = await pool.query<{ attempts: number; status: string; reviews: number }>(
      `SELECT dispatch.attempts, dispatch.status,
              (SELECT count(*)::int FROM jobs WHERE kind = 'review') AS reviews
         FROM jobs dispatch
        WHERE dispatch.kind = 'webhook-dispatch'
          AND dispatch.payload->>'deliveryId' = 'delivery-converged'`,
    );
    expect(result.rows[0]).toEqual({ attempts: 1, status: "done", reviews: 1 });
  });

  test("a newer ref snapshot retries until the live refs converge", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 256);
    await seedRepo(inst, 7884, "octo/ref-convergence");
    pullRequestReviewContext = {
      open: true,
      merged: false,
      headSha: "old-head",
      baseSha: "base",
      draft: false,
      updatedAt: "2026-08-24T12:34:55Z",
    };

    expect(
      (
        await post(
          "pull_request",
          {
            action: "synchronize",
            installation: { id: 256 },
            repository: { id: 7884, full_name: "octo/ref-convergence", private: false },
            pull_request: {
              number: 13,
              head: { sha: "new-head" },
              base: { sha: "base" },
              updated_at: "2026-08-24T12:34:56Z",
            },
          },
          "delivery-ref-convergence",
        )
      ).status,
    ).toBe(200);

    pullRequestReviewContext = {
      ...pullRequestReviewContext,
      headSha: "new-head",
      updatedAt: "2026-08-24T12:34:56Z",
    };
    await runPendingWebhookDispatch(
      "delivery-ref-convergence",
      "webhook-ref-convergence",
    );
    const jobs = await pool.query<{ headSha: string }>(
      `SELECT payload->>'headSha' AS "headSha"
         FROM jobs
        WHERE kind = 'review'`,
    );
    expect(jobs.rows).toEqual([{ headSha: "new-head" }]);
  });

  test("non-newer contradictory refs fail closed with bounded equal-time retries", async () => {
    const orgId = await seedOrg();
    const cases = [
      {
        name: "live-newer",
        installationId: 258,
        githubRepoId: 7886,
        eventUpdatedAt: "2026-08-24T12:34:55Z",
        liveUpdatedAt: "2026-08-24T12:34:56Z",
        expectedAttempts: 1,
      },
      {
        name: "unknown",
        installationId: 259,
        githubRepoId: 7887,
        eventUpdatedAt: "2026-08-24",
        liveUpdatedAt: "2026-08-24T12:34:56Z",
        expectedAttempts: 1,
      },
      {
        name: "equal",
        installationId: 260,
        githubRepoId: 7888,
        eventUpdatedAt: "2026-08-24T12:34:56.900Z",
        liveUpdatedAt: "2026-08-24T12:34:56.100Z",
        expectedAttempts: 3,
      },
    ];

    for (const item of cases) {
      const installation = await seedInstallation(orgId, item.installationId);
      await seedRepo(
        installation,
        item.githubRepoId,
        `octo/ref-${item.name}`,
      );
      pullRequestReviewContext = {
        open: true,
        merged: false,
        headSha: "live-head",
        baseSha: "base",
        draft: false,
        updatedAt: item.liveUpdatedAt,
      };
      const deliveryId = `delivery-ref-${item.name}`;
      expect(
        (
          await post(
            "pull_request",
            {
              action: "synchronize",
              installation: { id: item.installationId },
              repository: {
                id: item.githubRepoId,
                full_name: `octo/ref-${item.name}`,
                private: false,
              },
              pull_request: {
                number: 15,
                head: { sha: "event-head" },
                base: { sha: "base" },
                updated_at: item.eventUpdatedAt,
              },
            },
            deliveryId,
          )
        ).status,
      ).toBe(200);

      if (item.name === "equal") {
        await runPendingWebhookDispatch(deliveryId, "webhook-ref-equal-second");
        await runPendingWebhookDispatch(deliveryId, "webhook-ref-equal-terminal");
      }

      const state = await pool.query<{
        status: string;
        attempts: number;
        completed: boolean;
      }>(
        `SELECT dispatch.status, dispatch.attempts,
                delivery.completed_at IS NOT NULL AS completed
           FROM jobs dispatch
           JOIN webhook_deliveries delivery
             ON delivery.delivery_id = dispatch.payload->>'deliveryId'
          WHERE dispatch.kind = 'webhook-dispatch'
            AND delivery.delivery_id = $1`,
        [deliveryId],
      );
      expect(state.rows[0]).toEqual({
        status: "done",
        attempts: item.expectedAttempts,
        completed: true,
      });
    }

    expect((await pool.query("SELECT 1 FROM jobs WHERE kind = 'review'")).rowCount).toBe(
      0,
    );
  });

  test("unknown timestamp ordering keeps contradictory events ignored", async () => {
    const cases = [
      {
        deliveryId: "delivery-missing-event-time",
        eventUpdatedAt: undefined,
        liveUpdatedAt: "2026-08-24T12:34:56Z",
      },
      {
        deliveryId: "delivery-malformed-event-time",
        eventUpdatedAt: "not-a-timestamp",
        liveUpdatedAt: "2026-08-24T12:34:56Z",
      },
      {
        deliveryId: "delivery-missing-live-time",
        eventUpdatedAt: "2026-08-24T12:34:56Z",
        liveUpdatedAt: undefined,
      },
    ];

    for (const item of cases) {
      pullRequestReviewContext = {
        open: false,
        merged: false,
        headSha: "same-head",
        baseSha: "base",
        draft: false,
        ...(item.liveUpdatedAt ? { updatedAt: item.liveUpdatedAt } : {}),
      };
      expect(
        (
          await post(
            "pull_request",
            {
              action: "reopened",
              installation: { id: 257 },
              repository: { id: 7885, full_name: "octo/unknown-time", private: false },
              pull_request: {
                number: 14,
                head: { sha: "same-head" },
                base: { sha: "base" },
                ...(item.eventUpdatedAt === undefined
                  ? {}
                  : { updated_at: item.eventUpdatedAt }),
              },
            },
            item.deliveryId,
          )
        ).status,
      ).toBe(200);
    }

    const states = await pool.query<{ status: string; attempts: number; completed: boolean }>(
      `SELECT dispatch.status, dispatch.attempts,
              delivery.completed_at IS NOT NULL AS completed
         FROM jobs dispatch
         JOIN webhook_deliveries delivery
           ON delivery.delivery_id = dispatch.payload->>'deliveryId'
        WHERE dispatch.kind = 'webhook-dispatch'
        ORDER BY delivery.delivery_id`,
    );
    expect(states.rows).toEqual([
      { status: "done", attempts: 1, completed: true },
      { status: "done", attempts: 1, completed: true },
      { status: "done", attempts: 1, completed: true },
    ]);
    expect((await pool.query("SELECT 1 FROM jobs WHERE kind = 'review'")).rowCount).toBe(0);
  });

  for (const action of ["opened", "synchronize"] as const) {
    test(`signed pull_request ${action} stays queued through exact release activation`, async () => {
      const releaseSha = action === "opened" ? "1".repeat(40) : "2".repeat(40);
      process.env.POSTIL_RELEASE_SHA = releaseSha;
      process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
      await deactivateHostedInferenceRelease(pool, releaseSha);
      const orgId = await seedOrg();
      const installationId = action === "opened" ? 271 : 272;
      const githubRepoId = action === "opened" ? 8171 : 8172;
      const installation = await seedInstallation(orgId, installationId);
      await seedRepo(installation, githubRepoId, `octo/${action}`);
      pullRequestReviewContext = {
        ...pullRequestReviewContext,
        headSha: `${action}-head`,
        baseSha: `${action}-base`,
      };
      const deliveryId = `release-dark-${action}`;

      expect((await post("pull_request", {
        action,
        installation: { id: installationId },
        repository: {
          id: githubRepoId,
          full_name: `octo/${action}`,
          private: false,
        },
        pull_request: {
          number: 17,
          head: { sha: `${action}-head` },
          base: { sha: `${action}-base` },
        },
      }, deliveryId)).status).toBe(200);

      const receipt = await pool.query<{
        completed: boolean;
        dispatch_done: boolean;
      }>(
        `SELECT delivery.completed_at IS NOT NULL AS completed,
                dispatch.status = 'done' AS dispatch_done
           FROM webhook_deliveries AS delivery
           JOIN jobs AS dispatch
             ON dispatch.kind = 'webhook-dispatch'
            AND dispatch.payload->>'deliveryId' = delivery.delivery_id
          WHERE delivery.delivery_id = $1`,
        [deliveryId],
      );
      expect(receipt.rows[0]).toEqual({ completed: true, dispatch_done: true });

      const claimed = await claimJob(pool, `release-dark-${action}`, ["review"]);
      expect(claimed?.kind).toBe("review");
      await runClaimedJob(claimed!, `release-dark-${action}`);
      const deferred = await pool.query<{
        status: string;
        staged: boolean;
        release_sha: string | null;
        attempts: number;
      }>(
        `SELECT status, run_after = 'infinity'::timestamptz AS staged,
                payload->>'releaseDarkSha' AS release_sha, attempts
           FROM jobs WHERE id = $1`,
        [claimed!.id],
      );
      expect(deferred.rows[0]).toEqual({
        status: "queued",
        staged: true,
        release_sha: releaseSha,
        attempts: 0,
      });
      expect((await pool.query("SELECT 1 FROM reviews")).rowCount).toBe(0);

      expect(await activateHostedInferenceRelease(pool, releaseSha)).toBe(true);
      const released = await pool.query<{
        status: string;
        staged: boolean;
        release_sha: string | null;
      }>(
        `SELECT status, run_after = 'infinity'::timestamptz AS staged,
                payload->>'releaseDarkSha' AS release_sha
           FROM jobs WHERE id = $1`,
        [claimed!.id],
      );
      expect(released.rows[0]).toEqual({
        status: "queued",
        staged: false,
        release_sha: null,
      });
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM jobs
          WHERE kind = 'review' AND payload->>'headSha' = $1`,
        [`${action}-head`],
      )).rows[0]!.count).toBe(1);
    });
  }

  test("pull_request close revokes queued publication and neutralizes active checks", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 251);
    const repoId = await seedRepo(inst, 7879, "octo/closing");
    await pool.query(
      `INSERT INTO reviews
         (repository_id, source_org_id, source_installation_id,
          source_github_installation_id, source_github_repo_id,
          source_repo_full_name, pr_number, head_sha, base_sha, status,
          advisory_check_run_id, gate_check_run_id, queued_at, started_at)
       VALUES ($1, $2, $3, 251, 7879, 'octo/closing', 7, 'closing-head',
               'base', 'running', 31, 32, now(), now())`,
      [repoId, orgId, inst],
    );
    const respond = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload)
       VALUES ('respond', $1::jsonb) RETURNING id`,
      [JSON.stringify({
        installationId: 251,
        sourceInstallationId: inst,
        sourceOrgId: orgId,
        githubRepoId: 7879,
        repoFullName: "octo/closing",
        number: 7,
        isPr: true,
        sourceHeadSha: "closing-head",
      })],
    );
    await pool.query(
      `INSERT INTO respond_deliveries
         (job_id, repository_id, source_org_id, source_installation_id,
          source_github_installation_id, source_github_repo_id, repo_full_name,
          issue_number, is_pr, source_head_sha, body)
       VALUES ($1, $2, $3, $4, 251, 7879, 'octo/closing', 7, true,
               'closing-head', 'queued reply')`,
      [respond.rows[0]!.id, repoId, orgId, inst],
    );
    pullRequestReviewContext = {
      ...pullRequestReviewContext,
      open: false,
      merged: true,
      headSha: "closing-head",
      baseSha: "base",
    };

    expect((await post("pull_request", {
      action: "closed",
      installation: { id: 251 },
      repository: { id: 7879, full_name: "octo/closing", private: false },
      pull_request: {
        number: 7,
        head: { sha: "closing-head" },
        base: { sha: "base" },
      },
    }, "delivery-close-1")).status).toBe(200);

    const state = await pool.query(
      `SELECT review.status AS review_status, job.status AS job_status,
              delivery.state AS delivery_state
       FROM reviews review
       JOIN jobs job ON job.id = $1
       JOIN respond_deliveries delivery ON delivery.job_id = job.id`,
      [respond.rows[0]!.id],
    );
    expect(state.rows[0]).toEqual({
      review_status: "stale",
      job_status: "done",
      delivery_state: "cancelled",
    });
    expect(
      completedCheckRuns.map(({ repoFullName, conclusion }) => ({
        repoFullName,
        conclusion,
      })),
    ).toEqual([
      { repoFullName: "octo/closing", conclusion: "neutral" },
      { repoFullName: "octo/closing", conclusion: "neutral" },
    ]);
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

    // Both the gate and review check-runs failed before the repo row and its
    // cascaded review were deleted.
    expect(completedCheckRuns).toHaveLength(2);
    expect(completedCheckRuns.map((c) => c.conclusion).sort()).toEqual(["failure", "failure"]);
    expect(completedCheckRuns.every((c) => c.repoFullName === "octo/gone")).toBe(true);
    expect(
      completedCheckRuns.every((c) =>
        /^https:\/\/postil\.dev\/orgs\/octo\/runs\/[0-9a-f-]+$/.test(
          c.detailsUrl ?? "",
        ),
      ),
    ).toBe(true);

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
    expect(pullRequestReviewContextFetchCount).toBe(0);
  });

  test("dismissal records its audit tag, flags author self-dismissal, and clears severity blocking", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    const reviewId = await seedCompletedApprovalReview(repoId, approvalEnvelope({
      findings: [{
        id: "kind-blocker", path: "src/app.ts", line: 10, severity: "error", kind: "risk",
        confidence: 0.9, title: "Incorrect finding", body: "The branch is unreachable.",
      }],
      counts: { info: 0, warn: 0, error: 1, suppressed: 0, ungrounded: 0 },
      scorerModel: "scorer/webhook",
    }));
    await pool.query("UPDATE reviews SET author_github_id = 501 WHERE id = $1", [reviewId]);

    expect((await dismissalComment("dismissal-success")).status).toBe(200);
    const dismissal = await pool.query<{
      verb: string;
      reason_tag: string;
      author_self_dismissal: boolean;
      finding_model: string;
      finding_scorer_model: string;
    }>("SELECT verb, reason_tag, author_self_dismissal, finding_model, finding_scorer_model FROM finding_approvals WHERE review_id = $1", [reviewId]);
    expect(dismissal.rows).toEqual([{
      verb: "dismiss", reason_tag: "false-positive", author_self_dismissal: true,
      finding_model: "deepseek/deepseek-v4-pro",
      finding_scorer_model: "scorer/webhook",
    }]);
    expect((await pool.query<{ gate_failing: boolean }>("SELECT gate_failing FROM reviews WHERE id = $1", [reviewId])).rows[0]!.gate_failing).toBe(false);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain(
      "The pull request author dismissed this finding.",
    );
  });

  test("dismissal infers a finding id only from its finding-comment reply", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    const reviewId = await seedCompletedApprovalReview(repoId);
    await pool.query(
      `INSERT INTO finding_publications (review_id, finding_id, stable_identity, initial_state, current_state, github_comment_id)
       VALUES ($1, 'kind-blocker', false, 'inline', 'inline', '8800')`,
      [reviewId],
    );

    expect((await post("pull_request_review_comment", {
      action: "created",
      installation: { id: 700 },
      repository: { id: 7000, full_name: "octo/approvals", private: false },
      sender: { id: 501, login: "admin", type: "User" },
      comment: {
        id: 8801, in_reply_to_id: 8800, body: "@postil dismiss -- out-of-scope: this policy does not apply",
        user: { id: 501, login: "admin", type: "User" }, author_association: "MEMBER",
      },
      pull_request: { number: 9 },
    }, "dismissal-reply-inference")).status).toBe(200);
    expect((await pool.query<{ finding_id: string; reason_tag: string }>(
      "SELECT finding_id, reason_tag FROM finding_approvals WHERE review_id = $1", [reviewId],
    )).rows).toEqual([{ finding_id: "kind-blocker", reason_tag: "out-of-scope" }]);
  });

  test("dismissal rejects a same-pull-request review that is queued or running", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(repoId);
    await pool.query(
      "INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status) VALUES ($1, 9, 'next-head', 'base-sha', 'queued')",
      [repoId],
    );

    expect((await dismissalComment("dismissal-race")).status).toBe(200);
    expect((await pool.query<{ c: number }>("SELECT count(*)::int AS c FROM finding_approvals")).rows[0]!.c).toBe(0);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain("review is in progress");
  });

  test("approval command accepts the truncated finding id shown in gate summaries", async () => {
    const fullId = "a1b2c3d4e5f6".padEnd(64, "0");
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    const envelope = approvalEnvelope();
    (envelope.findings as Array<{ id: string }>)[0]!.id = fullId;
    const reviewId = await seedCompletedApprovalReview(repoId, envelope);

    const res = await approvalComment(
      "approval-prefix",
      `@postil approve ${fullId.slice(0, 12)} -- reviewed`,
    );

    expect(res.status).toBe(200);
    const approvals = await pool.query<{ finding_id: string }>(
      "SELECT finding_id FROM finding_approvals WHERE review_id = $1",
      [reviewId],
    );
    expect(approvals.rows).toEqual([{ finding_id: fullId }]);
    const replies = await queuedWebhookCommentBodies();
    expect(replies[0]).toContain(`Approval recorded by @admin for finding ${fullId}`);
  });

  test("approval command rejects a finding id prefix matching several findings", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    const envelope = approvalEnvelope();
    const template = envelope.findings[0]!;
    envelope.findings = [
      { ...template, id: "a1b2c3d4e5f6".padEnd(64, "0") },
      { ...template, id: "a1b2c3d4e5f6".padEnd(64, "1"), line: 20 },
    ];
    const reviewId = await seedCompletedApprovalReview(repoId, envelope);

    const res = await approvalComment(
      "approval-prefix-ambiguous",
      "@postil approve a1b2c3d4e5f6 -- reviewed",
    );

    expect(res.status).toBe(200);
    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals WHERE review_id = $1",
      [reviewId],
    );
    expect(approvals.rows[0]!.c).toBe(0);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain(
      "matches 2 blocking findings",
    );
  });

  test("approval command verifies and records a live admin who has never signed in", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    const reviewId = await seedCompletedApprovalReview(repoId);

    expect((await approvalComment("approval-without-session")).status).toBe(200);

    const approval = await pool.query<{
      actor_github_id: string;
      actor_login_snapshot: string;
      actor_role_snapshot: string;
      rationale: string;
      source_binding_state: string;
    }>(
      `SELECT actor_github_id, actor_login_snapshot, actor_role_snapshot, rationale,
              source_binding_state
         FROM finding_approvals
        WHERE review_id = $1`,
      [reviewId],
    );
    expect(approval.rows).toEqual([
      {
        actor_github_id: "501",
        actor_login_snapshot: "admin",
        actor_role_snapshot: "admin",
        rationale: "reviewed",
        source_binding_state: "exact",
      },
    ]);
    expect(membershipFetchCount).toBe(1);
  });

  test("approval command does not depend on an unexpired web session", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 hour'");
    const reviewId = await seedCompletedApprovalReview(repoId);

    expect((await approvalComment("approval-expired-session")).status).toBe(200);

    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals WHERE review_id = $1",
      [reviewId],
    );
    expect(approvals.rows[0]!.c).toBe(1);
    expect(membershipFetchCount).toBe(1);
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
    const jobs = await pool.query<{ payload: { trigger: Record<string, unknown> } }>(
      "SELECT payload FROM jobs WHERE kind = 'respond'",
    );
    expect(approvals.rows[0]!.c).toBe(0);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload.trigger).toEqual({
      source: "github_mention",
      webhookDeliveryId: "approval-free-form",
      webhookEvent: "issue_comment",
      webhookAction: "created",
      sourceCommentId: 123456,
      sourceUrl: "https://github.com/octo/approvals/pull/9#issuecomment-123456",
      requestedByGithubId: 501,
      requestedByLogin: "admin",
    });
  });

  test("retries a missing acknowledgement after response admission", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 707);
    await seedRepo(inst, 7007, "octo/retry-ack");
    await pool.query(
      `INSERT INTO jobs (kind, payload)
       VALUES ('respond', $1::jsonb)`,
      [JSON.stringify({
        installationId: 707,
        sourceInstallationId: inst,
        sourceOrgId: orgId,
        githubRepoId: 7007,
        repoFullName: "octo/retry-ack",
        number: 9,
        isPr: false,
        comment: "@postil explain this",
        sourceDeliveryId: "retry-safe-ack",
      })],
    );

    expect((await post(
      "issue_comment",
      {
        action: "created",
        installation: { id: 707 },
        repository: { id: 7007, full_name: "octo/retry-ack", private: false },
        sender: { id: 507, login: "reviewer", type: "User" },
        comment: {
          id: 9101,
          body: "@postil explain this",
          user: { id: 507, login: "reviewer", type: "User" },
          author_association: "MEMBER",
        },
        issue: { number: 9 },
      },
      "retry-safe-ack",
    )).status).toBe(200);

    const jobs = await pool.query<{ kind: string; count: number }>(
      `SELECT kind, count(*)::int AS count FROM jobs
        WHERE kind IN ('respond', 'github-reaction')
        GROUP BY kind ORDER BY kind`,
    );
    expect(jobs.rows).toEqual([
      { kind: "github-reaction", count: 1 },
      { kind: "respond", count: 1 },
    ]);
  });

  test("exact PR review mentions enqueue the structured reviewer", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    await seedRepo(inst, 7000, "octo/approvals");

    const res = await approvalComment(
      "mention-review-current-head",
      "@postil-dev rerun the review for the current head. The previous hosted run ended without a review verdict.",
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
          trigger: {
            source: "requested_review",
            webhookDeliveryId: "mention-review-current-head",
            webhookEvent: "issue_comment",
            webhookAction: "created",
            sourceCommentId: 123456,
            sourceUrl: "https://github.com/octo/approvals/pull/9#issuecomment-123456",
            requestedByGithubId: 501,
            requestedByLogin: "admin",
          },
        }),
      },
      {
        kind: "github-reaction",
        payload: {
          installationId: 700,
          sourceInstallationId: inst,
          sourceOrgId: orgId,
          githubRepoId: 7000,
          repoFullName: "octo/approvals",
          commentId: 123456,
          commentKind: "issue_comment",
          content: "eyes",
          sourceDeliveryId: "mention-review-current-head",
        },
      },
    ]);

    const duplicate = await approvalComment(
      "mention-review-current-head",
      "@postil-dev rerun the review for the current head. The previous hosted run ended without a review verdict.",
    );
    expect(duplicate.status).toBe(200);
    const reactionCount = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM jobs WHERE kind = 'github-reaction'",
    );
    expect(reactionCount.rows[0]!.count).toBe(1);
    const reactionJob = await claimJob(getPool(), "reaction-test", ["github-reaction"]);
    expect(reactionJob?.kind).toBe("github-reaction");
    await runClaimedJob(reactionJob!, "reaction-test", "worker");
    expect(addedReactions).toEqual([
      {
        repoFullName: "octo/approvals",
        commentId: 123456,
        kind: "issue_comment",
      },
    ]);
  });

  test("review-thread commands retain their comment origin", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 702);
    await seedRepo(inst, 7002, "octo/threaded");

    const res = await post(
      "pull_request_review_comment",
      {
        action: "created",
        installation: { id: 702 },
        repository: { id: 7002, full_name: "octo/threaded", private: false },
        sender: { id: 502, login: "reviewer", type: "User" },
        comment: {
          id: 654321,
          html_url: "https://github.com/octo/threaded/pull/5#discussion_r654321",
          body: "@postil review the current head",
          user: { id: 502, login: "reviewer", type: "User" },
          author_association: "MEMBER",
          path: "src/app.ts",
          line: 10,
        },
        pull_request: { number: 5 },
      },
      "review-thread-command",
    );

    expect(res.status).toBe(200);
    const jobs = await pool.query<{ payload: { trigger: Record<string, unknown> } }>(
      "SELECT payload FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]!.payload.trigger).toEqual({
      source: "requested_review",
      webhookDeliveryId: "review-thread-command",
      webhookEvent: "pull_request_review_comment",
      webhookAction: "created",
      sourceCommentId: 654321,
      sourceUrl: "https://github.com/octo/threaded/pull/5#discussion_r654321",
      requestedByGithubId: 502,
      requestedByLogin: "reviewer",
    });
    const reactions = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM jobs WHERE kind = 'github-reaction'",
    );
    expect(reactions.rows[0]!.payload).toEqual({
      installationId: 702,
      sourceInstallationId: inst,
      sourceOrgId: orgId,
      githubRepoId: 7002,
      repoFullName: "octo/threaded",
      commentId: 654321,
      commentKind: "pull_request_review_comment",
      content: "eyes",
      sourceDeliveryId: "review-thread-command",
    });
  });

  test("clarification replies to Postil stay bound to the review thread", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 704);
    await seedRepo(inst, 7004, "octo/threaded-reply");

    const res = await post(
      "pull_request_review_comment",
      {
        action: "created",
        installation: { id: 704 },
        repository: {
          id: 7004,
          full_name: "octo/threaded-reply",
          private: false,
        },
        sender: { id: 504, login: "reviewer", type: "User" },
        comment: {
          id: 8801,
          in_reply_to_id: 8800,
          body: "Why can this return early?",
          user: { id: 504, login: "reviewer", type: "User" },
          author_association: "MEMBER",
          path: "src/app.ts",
          line: 12,
        },
        pull_request: { number: 5 },
      },
      "review-thread-clarification",
    );

    expect(res.status).toBe(200);
    const jobs = await pool.query<{
      kind: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT kind, payload FROM jobs
        WHERE kind IN ('respond', 'github-reaction') ORDER BY id`,
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows[0]).toMatchObject({
      kind: "respond",
      payload: {
        replyToReviewCommentId: 8800,
        threadContext: "The nullable branch can return before this check.",
        comment: "Why can this return early?",
      },
    });
    expect(jobs.rows[1]).toMatchObject({
      kind: "github-reaction",
      payload: { commentId: 8801, content: "eyes" },
    });
  });

  test("gratitude in a Postil thread reacts without model work", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 705);
    await seedRepo(inst, 7005, "octo/threaded-thanks");

    expect((await post(
      "pull_request_review_comment",
      {
        action: "created",
        installation: { id: 705 },
        repository: {
          id: 7005,
          full_name: "octo/threaded-thanks",
          private: false,
        },
        sender: { id: 505, login: "reviewer", type: "User" },
        comment: {
          id: 8901,
          in_reply_to_id: 8800,
          body: "Thanks again!",
          user: { id: 505, login: "reviewer", type: "User" },
          author_association: "MEMBER",
        },
        pull_request: { number: 6 },
      },
      "review-thread-gratitude",
    )).status).toBe(200);

    const jobs = await pool.query<{
      kind: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT kind, payload FROM jobs
        WHERE kind IN ('respond', 'github-reaction') ORDER BY id`,
    );
    expect(jobs.rows).toEqual([
      expect.objectContaining({
        kind: "github-reaction",
        payload: expect.objectContaining({ commentId: 8901, content: "+1" }),
      }),
    ]);
  });

  test("ignores unmentioned replies when the thread root is not Postil", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 706);
    await seedRepo(inst, 7006, "octo/human-thread");
    reviewCommentRoot = { ...reviewCommentRoot, userLogin: "another-reviewer" };

    expect((await post(
      "pull_request_review_comment",
      {
        action: "created",
        installation: { id: 706 },
        repository: { id: 7006, full_name: "octo/human-thread", private: false },
        sender: { id: 506, login: "reviewer", type: "User" },
        comment: {
          id: 9001,
          in_reply_to_id: 8800,
          body: "Why is this needed?",
          user: { id: 506, login: "reviewer", type: "User" },
          author_association: "MEMBER",
        },
        pull_request: { number: 7 },
      },
      "human-thread-reply",
    )).status).toBe(200);

    const jobs = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs
        WHERE kind IN ('respond', 'github-reaction')`,
    );
    expect(jobs.rows[0]!.count).toBe(0);
  });

  async function seedPublishedFinding(
    repoId: number,
    findingId = "feedback-finding",
    envelope: Record<string, unknown> = approvalEnvelope(),
  ): Promise<number> {
    const reviewId = await seedCompletedApprovalReview(repoId, envelope);
    const publication = await pool.query<{ id: string }>(
      `INSERT INTO finding_publications
         (review_id, finding_id, stable_identity, initial_state, current_state, github_comment_id)
       VALUES ($1, $2, true, 'inline', 'inline', '8800')
       RETURNING id`,
      [reviewId, findingId],
    );
    return Number(publication.rows[0]!.id);
  }

  function feedbackReply(
    deliveryId: string,
    commentId: number,
    body: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Response> {
    return post(
      "pull_request_review_comment",
      {
        action: "created",
        installation: { id: 710 },
        repository: { id: 7010, full_name: "octo/finding-feedback", private: false },
        sender: { id: 510, login: "reviewer", type: "User" },
        comment: {
          id: commentId,
          in_reply_to_id: 8800,
          body,
          created_at: "2026-08-24T12:34:56Z",
          user: { id: 510, login: "reviewer", type: "User" },
          author_association: "MEMBER",
        },
        pull_request: {
          number: 9,
          user: { id: 511, login: "pull-request-author", type: "User" },
        },
        ...overrides,
      },
      deliveryId,
    );
  }

  test("persists eligible finding feedback without changing approvals or the gate", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 710);
    const repoId = await seedRepo(inst, 7010, "octo/finding-feedback");
    const publicationId = await seedPublishedFinding(repoId);

    expect((await feedbackReply("finding-feedback-wrong", 9101, "This finding is wrong.")).status)
      .toBe(200);
    expect((await feedbackReply("finding-feedback-risk", 9102, "We accept this risk.")).status)
      .toBe(200);
    expect((await feedbackReply("finding-feedback-scope", 9103, "This is outside the scope of this pull request.")).status)
      .toBe(200);
    expect((await feedbackReply("finding-feedback-author", 9104, "This is unhelpful.", {
      sender: { id: 511, login: "pull-request-author", type: "User" },
      comment: {
        id: 9104,
        in_reply_to_id: 8800,
        body: "This is unhelpful.",
        created_at: "2026-08-24T12:34:56Z",
        user: { id: 511, login: "pull-request-author", type: "User" },
        author_association: "NONE",
      },
    })).status).toBe(200);
    expect((await feedbackReply("finding-feedback-first-time-author", 9105, "This is still unhelpful.", {
      sender: { id: 511, login: "pull-request-author", type: "User" },
      comment: {
        id: 9105,
        in_reply_to_id: 8800,
        body: "This is still unhelpful.",
        created_at: "2026-08-24T12:34:56Z",
        user: { id: 511, login: "pull-request-author", type: "User" },
        author_association: "FIRST_TIME_CONTRIBUTOR",
      },
    })).status).toBe(200);
    expect((await feedbackReply("finding-feedback-replay", 9101, "This finding is wrong.")).status)
      .toBe(200);

    const feedback = await pool.query<{
      finding_publication_id: string;
      source: string;
      source_github_comment_id: string | null;
      actor_github_id: string;
      actor_login_snapshot: string;
      pr_author_github_id: string;
      pr_author_login_snapshot: string;
      actor_is_pr_author: boolean;
      body: string | null;
      observed_at: Date;
      source_delivery_id: string | null;
      suggested_reason_tag: string | null;
    }>(`
      SELECT finding_publication_id, source, source_github_comment_id,
             actor_github_id, actor_login_snapshot,
             pr_author_github_id, pr_author_login_snapshot, actor_is_pr_author,
             body, observed_at, source_delivery_id, suggested_reason_tag
        FROM finding_feedback
       ORDER BY source_github_comment_id
    `);
    expect(feedback.rows).toEqual([
      {
        finding_publication_id: String(publicationId),
        source: "reply",
        source_github_comment_id: "9101",
        actor_github_id: "510",
        actor_login_snapshot: "reviewer",
        pr_author_github_id: "511",
        pr_author_login_snapshot: "pull-request-author",
        actor_is_pr_author: false,
        body: "This finding is wrong.",
        observed_at: new Date("2026-08-24T12:34:56Z"),
        source_delivery_id: "finding-feedback-wrong",
        suggested_reason_tag: "false-positive",
      },
      expect.objectContaining({
        source_github_comment_id: "9102",
        suggested_reason_tag: "accepted-risk",
      }),
      expect.objectContaining({
        source_github_comment_id: "9103",
        suggested_reason_tag: "out-of-scope",
      }),
      expect.objectContaining({
        source_github_comment_id: "9104",
        actor_is_pr_author: true,
        suggested_reason_tag: null,
      }),
      expect.objectContaining({
        source_github_comment_id: "9105",
        actor_is_pr_author: true,
        suggested_reason_tag: null,
      }),
    ]);

    const state = await pool.query<{ gate_failing: boolean; approval_count: number }>(`
      SELECT review.gate_failing,
             (SELECT count(*)::int FROM finding_approvals WHERE review_id = review.id) AS approval_count
        FROM reviews review
       WHERE review.id = (
         SELECT review_id FROM finding_publications WHERE id = $1
       )
    `, [publicationId]);
    expect(state.rows).toEqual([{ gate_failing: true, approval_count: 0 }]);
  });

  test("keeps operational-sentinel feedback separate from gate decisions", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 710);
    const repoId = await seedRepo(inst, 7010, "octo/finding-feedback");
    const publicationId = await seedPublishedFinding(
      repoId,
      "operational-feedback",
      approvalEnvelope({
        findings: [{
          id: "operational-feedback",
          path: ".postil/operational",
          line: 1,
          severity: "error",
          kind: "uncertainty",
          confidence: 1,
          title: "Model provider unavailable",
          body: "Provider returned an invalid response.",
        }],
        counts: { info: 0, warn: 0, error: 1, suppressed: 0, ungrounded: 0 },
      }),
    );

    expect((await feedbackReply("operational-feedback", 9104, "This is a false positive.")).status)
      .toBe(200);

    const state = await pool.query<{ feedback_count: number; approval_count: number; gate_failing: boolean }>(`
      SELECT
        (SELECT count(*)::int FROM finding_feedback WHERE finding_publication_id = $1) AS feedback_count,
        (SELECT count(*)::int FROM finding_approvals WHERE review_id = publication.review_id) AS approval_count,
        review.gate_failing
      FROM finding_publications publication
      JOIN reviews review ON review.id = publication.review_id
      WHERE publication.id = $1
    `, [publicationId]);
    expect(state.rows).toEqual([{ feedback_count: 1, approval_count: 0, gate_failing: true }]);
  });

  test("records historical private-repository feedback without inference entitlement", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 711);
    const repoId = await seedRepo(inst, 7011, "octo/private-feedback", true);
    const publicationId = await seedPublishedFinding(repoId);

    expect((await feedbackReply("private-finding-feedback", 9150, "This is unhelpful.", {
      installation: { id: 711 },
      repository: {
        id: 7011,
        full_name: "octo/private-feedback",
        private: true,
      },
    })).status).toBe(200);

    const feedback = await pool.query<{ finding_publication_id: string; body: string }>(
      `SELECT finding_publication_id, body
         FROM finding_feedback
        WHERE source_github_comment_id = '9150'`,
    );
    expect(feedback.rows).toEqual([{
      finding_publication_id: String(publicationId),
      body: "This is unhelpful.",
    }]);
    expect((await pool.query("SELECT 1 FROM jobs WHERE kind = 'respond'")).rowCount).toBe(0);
  });

  test("does not capture commands, questions, gratitude, unrelated roots, or ineligible replies", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 710);
    const repoId = await seedRepo(inst, 7010, "octo/finding-feedback");
    await seedPublishedFinding(repoId);

    expect((await feedbackReply("feedback-question", 9201, "Why is this finding here?")).status).toBe(200);
    expect((await feedbackReply("feedback-gratitude", 9202, "Thanks again!")).status).toBe(200);
    expect((await feedbackReply("feedback-command", 9203, "@postil review current head")).status).toBe(200);

    reviewCommentRoot = { ...reviewCommentRoot, userLogin: "another-reviewer" };
    expect((await feedbackReply("feedback-unrelated", 9204, "This finding is wrong.")).status).toBe(200);
    reviewCommentRoot = { ...reviewCommentRoot, userLogin: "postil-dev[bot]" };

    expect((await feedbackReply("feedback-unauthorized", 9205, "This finding is wrong.", {
      comment: {
        id: 9205,
        in_reply_to_id: 8800,
        body: "This finding is wrong.",
        created_at: "2026-08-24T12:34:56Z",
        user: { id: 510, login: "reviewer", type: "User" },
        author_association: "NONE",
      },
    })).status).toBe(200);
    expect((await feedbackReply("feedback-first-time-unauthorized", 9207, "This finding is wrong.", {
      comment: {
        id: 9207,
        in_reply_to_id: 8800,
        body: "This finding is wrong.",
        created_at: "2026-08-24T12:34:56Z",
        user: { id: 510, login: "reviewer", type: "User" },
        author_association: "FIRST_TIME_CONTRIBUTOR",
      },
    })).status).toBe(200);
    expect((await feedbackReply("feedback-bot", 9206, "This finding is wrong.", {
      sender: { id: 510, login: "reviewer[bot]", type: "Bot" },
    })).status).toBe(200);

    const feedback = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM finding_feedback",
    );
    expect(feedback.rows[0]!.count).toBe(0);
  });

  test("does not acknowledge an exact command from an unauthorized commenter", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 703);
    await seedRepo(inst, 7003, "octo/public");

    const res = await post(
      "issue_comment",
      {
        action: "created",
        installation: { id: 703 },
        repository: { id: 7003, full_name: "octo/public", private: false },
        sender: { id: 999, login: "visitor", type: "User" },
        comment: {
          id: 777777,
          body: "@postil review the current head",
          user: { id: 999, login: "visitor", type: "User" },
          author_association: "NONE",
        },
        issue: { number: 6, pull_request: {} },
      },
      "unauthorized-review-command",
    );

    expect(res.status).toBe(200);
    const jobs = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM jobs
        WHERE kind IN ('review', 'github-reaction')`,
    );
    expect(jobs.rows[0]!.count).toBe(0);
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

  test("approval command rejects incomplete identities and live non-admin members", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedCompletedApprovalReview(repoId);

    liveMembershipUserId = 0;
    expect((await approvalComment("approval-unverified")).status).toBe(200);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain("could not verify");

    liveMembershipUserId = 501;
    liveMembershipRole = "member";
    expect((await approvalComment("approval-member")).status).toBe(200);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain(
      "requires an organization admin",
    );

    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals",
    );
    expect(approvals.rows[0]!.c).toBe(0);
  });

  test("approval command rejects a departed actor without rewriting cached membership", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(repoId);
    liveMembershipStatus = 404;

    expect((await approvalComment("approval-left-org")).status).toBe(200);

    expect(
      (
        await pool.query<{ c: number }>(
          "SELECT count(*)::int AS c FROM finding_approvals",
        )
      ).rows[0]!.c,
    ).toBe(0);
    expect(
      (
        await pool.query<{ c: number }>(
          "SELECT count(*)::int AS c FROM org_members WHERE org_id = $1",
          [orgId],
        )
      ).rows[0]!.c,
    ).toBe(1);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain("could not verify");
  });

  test("approval command rejects a demoted admin without rewriting cached membership", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(repoId);
    liveMembershipRole = "member";

    expect((await approvalComment("approval-demoted")).status).toBe(200);

    expect(
      (
        await pool.query<{ role: string }>(
          "SELECT role FROM org_members WHERE org_id = $1",
          [orgId],
        )
      ).rows[0]!.role,
    ).toBe("admin");
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain(
      "requires an organization admin",
    );
  });

  test("approval command fails closed without deleting cached access during a GitHub outage", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(repoId);
    liveMembershipStatus = 503;

    expect((await approvalComment("approval-membership-outage")).status).toBe(200);

    expect(
      (
        await pool.query<{ role: string }>(
          "SELECT role FROM org_members WHERE org_id = $1",
          [orgId],
        )
      ).rows[0]!.role,
    ).toBe("admin");
    expect(
      (
        await pool.query<{ c: number }>(
          "SELECT count(*)::int AS c FROM finding_approvals",
        )
      ).rows[0]!.c,
    ).toBe(0);
  });

  test("approval command fails closed on an ambiguous membership response", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await seedCompletedApprovalReview(repoId);
    liveMembershipOrgId = 12345;

    expect((await approvalComment("approval-membership-mismatch")).status).toBe(200);

    expect(
      (
        await pool.query<{ c: number }>(
          "SELECT count(*)::int AS c FROM finding_approvals",
        )
      ).rows[0]!.c,
    ).toBe(0);
    expect(
      (
        await pool.query<{ role: string }>(
          "SELECT role FROM org_members WHERE org_id = $1",
          [orgId],
        )
      ).rows[0]!.role,
    ).toBe("admin");
  });

  test("approval command replay cannot create a second approval", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 700);
    const repoId = await seedRepo(inst, 7000, "octo/approvals");
    const reviewId = await seedCompletedApprovalReview(repoId);

    expect((await approvalComment("approval-first-delivery")).status).toBe(200);
    expect((await approvalComment("approval-replayed-comment")).status).toBe(200);

    const approvals = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM finding_approvals WHERE review_id = $1",
      [reviewId],
    );
    expect(approvals.rows[0]!.c).toBe(1);
    expect((await queuedWebhookCommentBodies()).at(-1)).toContain("already approved");
  });

  test("approval command recognizes a personal-account owner without an organization lookup", async () => {
    const orgId = await seedOrg();
    await pool.query("UPDATE organizations SET github_org_id = 501 WHERE id = $1", [orgId]);
    const inst = await seedInstallation(orgId, 700, "User");
    const repoId = await seedRepo(inst, 7000, "admin/approvals");
    await seedUser(501, "admin", orgId, "admin");
    await pool.query("DELETE FROM sessions");
    const reviewId = await seedCompletedApprovalReview(repoId);
    liveMembershipStatus = 503;

    expect(
      (
        await approvalComment(
          "approval-personal-owner",
          undefined,
          false,
          "admin/approvals",
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await pool.query<{ c: number }>(
          "SELECT count(*)::int AS c FROM finding_approvals WHERE review_id = $1",
          [reviewId],
        )
      ).rows[0]!.c,
    ).toBe(1);
    expect(membershipFetchCount).toBe(0);
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
          actor_role_snapshot, rationale, source, revoked_at, revoked_by_user_id,
          source_org_id, source_repository_id, source_github_installation_id,
          source_github_repo_id, source_pr_number, source_head_sha)
       SELECT review.id, 'kind-blocker', $2, '501', 'admin', 'admin',
              'revoked earlier', 'dashboard', now(), $2, review.source_org_id,
              review.repository_id, review.source_github_installation_id,
              review.source_github_repo_id, review.pr_number, review.head_sha
       FROM reviews review WHERE review.id = $1`,
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
          actor_role_snapshot, rationale, source, source_org_id,
          source_repository_id, source_github_installation_id, source_github_repo_id,
          source_pr_number, source_head_sha)
       SELECT review.id, 'kind-blocker', $2, '501', 'admin', 'admin',
              'approved old head', 'dashboard', review.source_org_id,
              review.repository_id, review.source_github_installation_id,
              review.source_github_repo_id, review.pr_number, review.head_sha
       FROM reviews review WHERE review.id = $1`,
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
        githubRepoId: 7000,
        installationAccountType: "Organization",
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

    const jobs = await pool.query<{
      payload: {
        prNumber: number;
        headSha: string;
        trigger: Record<string, unknown>;
      };
    }>(
      "SELECT payload FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload.prNumber).toBe(42);
    expect(jobs.rows[0]!.payload.headSha).toBe("deadbeef");
    expect(jobs.rows[0]!.payload.trigger).toEqual({
      source: "github_check_rerun",
      webhookDeliveryId: "delivery-rerequest-1",
      webhookEvent: "check_run",
      webhookAction: "rerequested",
      checkName: "postil/gate",
    });
  });

  test("check_suite rerequested records a check rerun without guessing a check name", async () => {
    const orgId = await seedOrg();
    const inst = await seedInstallation(orgId, 501);
    await seedRepo(inst, 5556, "octo/suite");

    const res = await post(
      "check_suite",
      {
        action: "rerequested",
        installation: { id: 501 },
        repository: { id: 5556, full_name: "octo/suite", private: false },
        check_suite: {
          head_sha: "suite-head",
          pull_requests: [
            {
              number: 43,
              head: { sha: "suite-head" },
              base: { sha: "suite-base" },
            },
          ],
        },
      },
      "delivery-suite-rerequest",
    );

    expect(res.status).toBe(200);
    const jobs = await pool.query<{ payload: { trigger: Record<string, unknown> } }>(
      "SELECT payload FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]!.payload.trigger).toEqual({
      source: "github_check_rerun",
      webhookDeliveryId: "delivery-suite-rerequest",
      webhookEvent: "check_suite",
      webhookAction: "rerequested",
    });
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
