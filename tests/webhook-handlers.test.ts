import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import { signWebhookBody } from "@/lib/crypto/webhook";

/**
 * Behavioural coverage for the webhook route beyond delivery dedupe:
 *
 *  - a repo transferred between installations is re-pinned to the new
 *    installation on the pull_request upsert (otherwise reviews skip),
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
// installation token so no real GitHub App credentials are needed.
const completedCheckRuns: Array<{ repoFullName: string; conclusion: string }> = [];
mock.module("@/lib/github/app-auth", () => ({
  getInstallationToken: async () => "fake-installation-token",
  apiBase: () => "https://api.github.com",
}));
mock.module("@/lib/github/checks", () => ({
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
  postIssueComment: async () => undefined,
}));

// Imported after the mocks are registered so the route picks up the stubs.
const { POST } = await import("@/app/api/webhooks/github/route");

function post(event: string, body: object, deliveryId: string): Promise<Response> {
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

describeDb("webhook handler behaviour", () => {
  let pool: Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
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
          if (code !== "42P07" && code !== "42710") throw err;
        }
      }
    }
  });

  beforeEach(async () => {
    completedCheckRuns.length = 0;
    delete process.env.POSTIL_RESPOND_HOURLY_CAP;
    await pool.query("TRUNCATE jobs RESTART IDENTITY");
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
  ): Promise<number> {
    const repo = await pool.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, $2, $3, false, true) RETURNING id`,
      [installationId, githubRepoId, fullName],
    );
    return Number(repo.rows[0]!.id);
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
        pull_request: { number: 7, head: { sha: "h" }, base: { sha: "b" } },
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
    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]!.c).toBe(1);
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

    const first = await checkRunRerequestedEvent("delivery-rerequest-dup-1");
    expect(first.status).toBe(200);

    // A second rerequest for the same repo+PR+head (e.g. the maintainer
    // clicks "Re-run" twice, or GitHub fires check_run once per check name)
    // must not enqueue a second review job while the first is still queued.
    const second = await checkRunRerequestedEvent("delivery-rerequest-dup-2", {
      name: "postil/review",
    });
    expect(second.status).toBe(200);

    const jobs = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM jobs WHERE kind = 'review'",
    );
    expect(jobs.rows[0]!.c).toBe(1);
  });
});
