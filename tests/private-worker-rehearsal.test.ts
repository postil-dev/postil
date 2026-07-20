import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import {
  armPrivateWorkerRehearsal,
  assertPrivateWorkerRehearsalOperator,
  configuredPrivateWorkerRehearsalSandbox,
  consumePrivateWorkerRehearsalAfterStaging,
  parseOperatorGithubIds,
  parsePrivateWorkerRehearsalSandbox,
  reconcilePrivateWorkerRehearsals,
  type PrivateWorkerRehearsalTarget,
} from "@/lib/private-worker-rehearsal";
import { claimJob } from "@/lib/queue";
import { parseArgs } from "../scripts/arm-private-worker-rehearsal";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const NOW = new Date("2026-07-20T18:00:00.000Z");
const TARGET: PrivateWorkerRehearsalTarget = {
  orgSlug: "postil-test",
  repoFullName: "postil-test/postil-sandbox",
  prNumber: 12,
  headSha: "a".repeat(40),
  reviewPublicId: "10000000-0000-4000-8000-000000000012",
};
const NONCE = "20000000-0000-4000-8000-000000000012";

describe("private worker rehearsal validation", () => {
  test("is disabled unless both the explicit switch and exact target are set", () => {
    const oldEnabled = process.env.POSTIL_WORKER_REHEARSAL_ENABLED;
    const oldSandbox = process.env.POSTIL_WORKER_REHEARSAL_SANDBOX;
    try {
      delete process.env.POSTIL_WORKER_REHEARSAL_ENABLED;
      delete process.env.POSTIL_WORKER_REHEARSAL_SANDBOX;
      expect(configuredPrivateWorkerRehearsalSandbox()).toBeNull();
      process.env.POSTIL_WORKER_REHEARSAL_ENABLED = "1";
      expect(() => configuredPrivateWorkerRehearsalSandbox()).toThrow(
        "SANDBOX is required",
      );
      process.env.POSTIL_WORKER_REHEARSAL_SANDBOX =
        `${TARGET.orgSlug}|${TARGET.repoFullName}`;
      expect(configuredPrivateWorkerRehearsalSandbox()).toEqual({
        orgSlug: TARGET.orgSlug,
        repoFullName: TARGET.repoFullName,
      });
    } finally {
      if (oldEnabled === undefined) delete process.env.POSTIL_WORKER_REHEARSAL_ENABLED;
      else process.env.POSTIL_WORKER_REHEARSAL_ENABLED = oldEnabled;
      if (oldSandbox === undefined) {
        delete process.env.POSTIL_WORKER_REHEARSAL_SANDBOX;
      } else {
        process.env.POSTIL_WORKER_REHEARSAL_SANDBOX = oldSandbox;
      }
    }
  });

  test("accepts only one exact target shape", () => {
    expect(
      parsePrivateWorkerRehearsalSandbox(
        `${TARGET.orgSlug}|${TARGET.repoFullName}`,
      ),
    ).toEqual({ orgSlug: TARGET.orgSlug, repoFullName: TARGET.repoFullName });
    expect(() =>
      parsePrivateWorkerRehearsalSandbox(
        `${TARGET.orgSlug}|repository-without-owner`,
      ),
    ).toThrow("repository is malformed");
    expect(() => parsePrivateWorkerRehearsalSandbox("postil-test|repo|12"))
      .toThrow("org|owner/repository");
  });

  test("validates operator identities and explicit command confirmation", () => {
    expect([...parseOperatorGithubIds("11, 22")]).toEqual([11, 22]);
    expect(() => parseOperatorGithubIds("11,login")).toThrow("numeric GitHub ids");
    expect(() => assertPrivateWorkerRehearsalOperator(11, "22"))
      .toThrow("not authorized");
    expect(() => assertPrivateWorkerRehearsalOperator(11, "11")).not.toThrow();
    expect(
      parseArgs([
        "--nonce",
        NONCE,
        "--operator-github-id",
        "11",
        "--confirm-review",
        TARGET.reviewPublicId,
        "--pr",
        String(TARGET.prNumber),
        "--head",
        TARGET.headSha,
        "--expires-in-seconds",
        "60",
        "--yes",
      ]),
    ).toEqual({
      nonce: NONCE,
      operatorGithubId: 11,
      confirmReview: TARGET.reviewPublicId,
      prNumber: TARGET.prNumber,
      headSha: TARGET.headSha,
      expiresInSeconds: 60,
      yes: true,
    });
    expect(() =>
      parseArgs([
        "--nonce",
        NONCE,
        "--operator-github-id",
        "11",
        "--confirm-review",
        TARGET.reviewPublicId,
        "--pr",
        String(TARGET.prNumber),
        "--head",
        TARGET.headSha,
        "--expires-in-seconds",
        "601",
      ]),
    ).toThrow("between 60 and 600");
  });

  test("keeps a rehearsal-owned job out of generic watchdog recovery", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "worker", "watchdog.ts"),
      "utf8",
    );
    expect(source).toContain("FROM private_worker_rehearsals rehearsal");
    expect(source).toContain("rehearsal.state = 'awaiting_replacement'");
  });

  test("gives an interrupted worker an explicit platform restart route", async () => {
    const source = await readFile(join(import.meta.dir, "..", "fly.toml"), "utf8");
    const worker = await readFile(
      join(import.meta.dir, "..", "src", "worker", "index.ts"),
      "utf8",
    );
    const launcher = await readFile(
      join(import.meta.dir, "..", "scripts", "start-managed-process.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /\[\[restart\]\][\s\S]*?policy = "on-failure"[\s\S]*?retries = 10[\s\S]*?processes = \["worker"\]/,
    );
    expect(worker).toContain(
      "`${hostname()}-${process.pid}-${randomUUID()}`",
    );
    expect(worker).toContain("process.exit(86)");
    expect(launcher).toContain("process.exit(exitCode)");
  });
});

describeDb("private worker interruption rehearsal", () => {
  const pool = new Pool({ connectionString: TEST_URL, max: 4 });
  let orgId = 0;
  let repositoryId = 0;
  let reviewId = 0;
  let jobId = 0;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const migration of migrations) {
      const source = await readFile(join(migrationDirectory, migration), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
  }, 30_000);

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE private_worker_rehearsals, service_heartbeats, usage_events, finding_publications, review_publication_receipts, review_logs, jobs, reviews, repositories, installations, organizations RESTART IDENTITY CASCADE",
    );
    const organization = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ($1, 'Postil test', 701) RETURNING id",
      [TARGET.orgSlug],
    );
    orgId = Number(organization.rows[0]!.id);
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, org_id)
       VALUES (702, $1, 'Organization', $2)
       RETURNING id`,
      [TARGET.orgSlug, orgId],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
         (github_repo_id, installation_id, full_name, private, enabled)
       VALUES (703, $1, $2, false, true)
       RETURNING id`,
      [installation.rows[0]!.id, TARGET.repoFullName],
    );
    repositoryId = Number(repository.rows[0]!.id);
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (public_id, repository_id, source_org_id, source_installation_id,
          source_github_installation_id, source_github_repo_id,
          source_repo_full_name, pr_number, head_sha, base_sha, status,
          advisory_check_run_id, gate_check_run_id,
          trigger_source, queued_at, started_at)
       VALUES
         ($1, $2, $3, $4, 702, 703, $5, $6, $7, $8, 'running',
          801, 802, 'unknown', $9, $9)
       RETURNING id`,
      [
        TARGET.reviewPublicId,
        repositoryId,
        orgId,
        installation.rows[0]!.id,
        TARGET.repoFullName,
        TARGET.prNumber,
        TARGET.headSha,
        "b".repeat(40),
        NOW,
      ],
    );
    reviewId = Number(review.rows[0]!.id);
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs
         (kind, payload, status, attempts, max_attempts, run_after,
          locked_at, locked_by, created_at)
       VALUES
         ('review', $1::jsonb, 'running', 1, 3, $2, $2, 'worker-old#0', $2)
       RETURNING id`,
      [
        JSON.stringify({
          repoFullName: TARGET.repoFullName,
          prNumber: TARGET.prNumber,
          headSha: TARGET.headSha,
          recoveryReviewId: reviewId,
          recoveryGateConclusion: "success",
        }),
        NOW,
      ],
    );
    jobId = Number(job.rows[0]!.id);
    await pool.query(
      `INSERT INTO service_heartbeats (component, instance_id, observed_at)
       VALUES ('worker', 'worker-old', $1)`,
      [NOW],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  test("fails closed for a mismatched target, duplicate nonce, and unsafe expiry", async () => {
    await expect(
      armPrivateWorkerRehearsal(
        pool,
        {
          ...TARGET,
          repoFullName: "postil-test/other",
          nonce: NONCE,
          operatorGithubId: 11,
          expiresAt: new Date(NOW.getTime() + 60_000),
          now: NOW,
        },
        TARGET,
      ),
    ).rejects.toThrow("sandbox allowlist");
    await expect(
      armPrivateWorkerRehearsal(
        pool,
        {
          ...TARGET,
          nonce: NONCE,
          operatorGithubId: 11,
          expiresAt: new Date(NOW.getTime() + 59_000),
          now: NOW,
        },
        TARGET,
      ),
    ).rejects.toThrow("between one and ten minutes");
    await armExact();
    await expect(armExact()).rejects.toThrow("already armed");
  });

  test("interrupts once only after staging and waits for a different worker", async () => {
    await armExact();
    expect(await consumeExact()).toBeNull();
    await stageTarget();
    const consumed = await Promise.all([
      consumeExact(),
      consumeExact(),
    ]);
    expect(consumed.filter(Boolean)).toEqual([NONCE]);

    const before = await pool.query(
      `SELECT state, interrupted_worker_instance,
              before_review_count, before_usage_count,
              before_check_count, before_publication_count
         FROM private_worker_rehearsals WHERE nonce = $1`,
      [NONCE],
    );
    expect(before.rows[0]).toMatchObject({
      state: "awaiting_replacement",
      interrupted_worker_instance: "worker-old",
      before_review_count: 1,
      before_usage_count: 0,
      before_check_count: 2,
      before_publication_count: 1,
    });

    expect((await jobState()).status).toBe("running");

    expect(
      await reconcilePrivateWorkerRehearsals(
        pool,
        new Date(NOW.getTime() + 30_000),
        TARGET,
      ),
    ).toMatchObject({ replacementsVerified: 0, jobsRequeued: 0 });
    await pool.query(
      `UPDATE service_heartbeats
          SET instance_id = 'worker-new', observed_at = $1
        WHERE component = 'worker'`,
      [new Date(NOW.getTime() + 31_000)],
    );
    expect(
      await reconcilePrivateWorkerRehearsals(
        pool,
        new Date(NOW.getTime() + 32_000),
        TARGET,
      ),
    ).toMatchObject({ replacementsVerified: 1, jobsRequeued: 1 });
    expect(await jobState()).toMatchObject({
      status: "queued",
      locked_by: null,
    });

    const webClaim = await claimJob(pool, "web-drain", ["review"], {
      excludePrivateWorkerRehearsals: true,
    });
    expect(webClaim).toBeNull();
    const workerClaim = await claimJob(pool, "worker-new#0", ["review"]);
    expect(workerClaim?.id).toBe(jobId);

    await pool.query(
      `INSERT INTO usage_events
         (org_id, repository_id, review_id, trigger_source,
          prompt_tokens, completion_tokens, model_used, cost_micros, billing_scope)
       VALUES ($1, $2, $3, 'unknown', 10, 5, 'test/model', 0, 'analytics')`,
      [orgId, repositoryId, reviewId],
    );
    await pool.query(
      `INSERT INTO finding_publications
         (review_id, finding_id, stable_identity, initial_state, current_state)
       VALUES ($1, 'finding-1', true, 'inline', 'inline')`,
      [reviewId],
    );
    await pool.query(
      "UPDATE reviews SET status = 'completed', finished_at = $2 WHERE id = $1",
      [reviewId, new Date(NOW.getTime() + 40_000)],
    );
    await pool.query(
      "UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE id = $1",
      [jobId],
    );
    expect(
      await reconcilePrivateWorkerRehearsals(
        pool,
        new Date(NOW.getTime() + 41_000),
        TARGET,
      ),
    ).toMatchObject({ rehearsalsCompleted: 1 });
    const after = await pool.query(
      `SELECT state, replacement_worker_instance,
              after_review_count, after_usage_count,
              after_check_count, after_publication_count
         FROM private_worker_rehearsals WHERE nonce = $1`,
      [NONCE],
    );
    expect(after.rows[0]).toMatchObject({
      state: "completed",
      replacement_worker_instance: "worker-new",
      after_review_count: 1,
      after_usage_count: 1,
      after_check_count: 2,
      after_publication_count: 2,
    });
    expect(await consumeExact()).toBeNull();
  });

  test("expires an unused one-shot request without touching its job", async () => {
    await armExact(60);
    expect(
      await reconcilePrivateWorkerRehearsals(
        pool,
        new Date(NOW.getTime() + 61_000),
        TARGET,
      ),
    ).toMatchObject({ rehearsalsExpired: 1, jobsRequeued: 0 });
    expect((await jobState()).status).toBe("running");
    expect(await consumeExact(new Date(NOW.getTime() + 61_000))).toBeNull();
  });

  async function armExact(expiresInSeconds = 300) {
    return armPrivateWorkerRehearsal(
      pool,
      {
        ...TARGET,
        nonce: NONCE,
        operatorGithubId: 11,
        expiresAt: new Date(NOW.getTime() + expiresInSeconds * 1_000),
        now: NOW,
      },
      TARGET,
    );
  }

  async function consumeExact(now = new Date(NOW.getTime() + 1_000)) {
    return consumePrivateWorkerRehearsalAfterStaging(pool, {
      reviewId,
      reviewJobId: jobId,
      repoFullName: TARGET.repoFullName,
      prNumber: TARGET.prNumber,
      headSha: TARGET.headSha,
      workerInstanceId: "worker-old",
      now,
      sandbox: TARGET,
    });
  }

  async function stageTarget() {
    await pool.query(
      "UPDATE reviews SET envelope = '{}'::jsonb WHERE id = $1",
      [reviewId],
    );
    await pool.query(
      `INSERT INTO review_publication_receipts
         (review_id, receipt_version, receipt_id, github_review_id, observed_at)
       VALUES ($1, 1, 'github-review-v1:rehearsal', '901', $2)`,
      [reviewId, NOW],
    );
  }

  async function jobState() {
    const result = await pool.query<{
      status: string;
      locked_by: string | null;
    }>("SELECT status, locked_by FROM jobs WHERE id = $1", [jobId]);
    return result.rows[0]!;
  }
});
