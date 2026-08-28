import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/lib/db/schema";
import type { Envelope, Finding } from "@/lib/envelope";
import {
  getOrgReviewRows,
  shippedPublicationStateSql,
} from "@/lib/org-reviews";
import {
  applyPublicationThreadObservations,
  getPullRequestPublicationThreadPlan,
  getReviewPublicationCounts,
  type PublicationReceipt,
} from "@/lib/publication-receipt";
import {
  finalizeStagedReviewCompletionWithGateMode,
  persistReviewCompletionWithGateMode,
  stageReviewCompletionCandidate,
} from "@/lib/review-completion";
import { withReviewDecisionScopeLock } from "@/lib/finding-approvals";
import {
  activatePublicationLifecycleRelease,
  deactivatePublicationLifecycleRelease,
  prepareManagedReleaseCapabilities,
  publicationLifecycleReleaseActivated,
  restoreManagedReleaseCapabilities,
  restoreManagedReleasePreparation,
  withPublicationLifecycleReleaseActive,
} from "@/lib/release-job-rollout";
import {
  compensateReleasePreparation,
  pendingReleasePreparationTargets,
  releasePreparationCleared,
} from "../scripts/run-release-migrations";

const realAppAuth = await import("@/lib/github/app-auth");
const realChecks = await import("@/lib/github/checks");
const realInstallationSync = await import("@/lib/github/installation-sync");
const realPublicationThreads = await import("@/lib/github/publication-threads");
let recoveryThreadObservationCount = 0;

mock.module("@/lib/github/app-auth", () => ({
  ...realAppAuth,
  getInstallationToken: async () => "test-token",
}));
mock.module("@/lib/github/checks", () => ({
  ...realChecks,
  verifyCompletedCheckRun: async () => undefined,
}));
mock.module("@/lib/github/installation-sync", () => ({
  ...realInstallationSync,
  fetchRepositorySummary: async () => ({
    id: 1003,
    full_name: "publication/repo",
  }),
}));
mock.module("@/lib/github/publication-threads", () => ({
  ...realPublicationThreads,
  observeGitHubReviewThreads: async () => {
    recoveryThreadObservationCount += 1;
    return [];
  },
  resolveGitHubReviewThreads: async () => [],
}));
mock.module("@/worker/runner", () => ({
  triggerQueueDrain: () => undefined,
}));

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

function finding(id: string, body = "A complete finding body."): Finding {
  return {
    id,
    path: "src/example.ts",
    line: 3,
    severity: "warn",
    kind: "risk",
    confidence: 0.8,
    title: `Finding ${id}`,
    body,
  };
}

function envelope(input: {
  findings?: Finding[];
  resolved?: Finding[];
  suppressed?: Finding[];
  head: string;
  since?: string | null;
}): Envelope {
  const findings = input.findings ?? [];
  const suppressedFindings = (input.suppressed ?? []).map((entry) => ({
    finding: entry,
    reason: "belowConfidence" as const,
  }));
  return {
    version: 1,
    summary: "",
    silent: findings.length === 0,
    findings,
    resolved: input.resolved ?? [],
    suppressedFindings,
    counts: {
      info: 0,
      warn: findings.length,
      error: 0,
      suppressed: suppressedFindings.length,
      ungrounded: 0,
    },
    confidenceBuckets: [0, 0, 0, 0, findings.length],
    gate: { failOn: "error", failing: false },
    modelUsed: "test/model",
    usage: { promptTokens: 1, completionTokens: 1 },
    durationMs: 1,
    baseSha: "a".repeat(40),
    headSha: input.head,
    sinceSha: input.since ?? null,
  };
}

describe("publication lifecycle database client safety", () => {
  test("discards a client when transaction start fails", async () => {
    const beginError = new Error("transaction start failed");
    const releasedWith: Array<Error | undefined> = [];
    const client = {
      query: async () => {
        throw beginError;
      },
      release: (error?: Error) => releasedWith.push(error),
    };
    const pool = {
      connect: async () => client,
    } as unknown as Pool;

    await expect(deactivatePublicationLifecycleRelease(pool)).rejects.toBe(
      beginError,
    );
    expect(releasedWith).toEqual([beginError]);
  });

  test("discards an activation client when rollback fails", async () => {
    const primaryError = new Error("activation query failed");
    const rollbackError = new Error("activation rollback failed");
    const releasedWith: Array<Error | undefined> = [];
    const client = {
      query: async (statement: string) => {
        if (statement === "SHOW lock_timeout") {
          return { rows: [{ lock_timeout: "0" }], rowCount: 1 };
        }
        if (statement.includes("SELECT count(*)::text AS count")) {
          throw primaryError;
        }
        if (statement === "ROLLBACK") throw rollbackError;
        return { rows: [], rowCount: 0 };
      },
      release: (error?: Error) => releasedWith.push(error),
    };
    const pool = {
      connect: async () => client,
    } as unknown as Pool;

    const result = activatePublicationLifecycleRelease(pool);
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toThrow(
      "publication lifecycle activation and rollback failed",
    );
    expect(releasedWith).toEqual([rollbackError]);
  });
});

describeDb("publication receipt migration and lifecycle", () => {
  const pool = new Pool({ connectionString: TEST_URL, max: 2 });
  const db = drizzle(pool, { schema });
  let orgId = 0;
  let installationId = 0;
  let repositoryId = 0;
  const reviewIds: number[] = [];

  async function createRunningReview(
    headSha: string,
    sinceSha: string | null = null,
    prNumber = 7,
    track = true,
  ) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, since_sha, status, trigger_source, queued_at, started_at)
       VALUES ($1, $2, $3, $4, $5, 'running', 'unknown', now(), now())
       RETURNING id`,
      [repositoryId, prNumber, headSha, "a".repeat(40), sinceSha],
    );
    const id = Number(result.rows[0]!.id);
    if (track) reviewIds.push(id);
    return id;
  }

  async function complete(
    reviewId: number,
    reviewEnvelope: Envelope,
    publicationReceipt?: PublicationReceipt,
  ) {
    expect(
      await persistReviewCompletionWithGateMode(db, {
        reviewId,
        envelope: reviewEnvelope,
        configFiles: [],
        silent: reviewEnvelope.silent,
        gateFailing: reviewEnvelope.gate.failing,
        usageAccountingComplete: true,
        publicationReceipt,
        usage: [
          {
            orgId,
            repositoryId,
            promptTokens: 1,
            completionTokens: 1,
            modelUsed: "test/model",
            costMicros: 0,
            billingScope: "analytics",
          },
        ],
      }, orgId),
    ).toMatchObject({ completed: true });
  }

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
    const organization = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('publication', 'Publication', 1001) RETURNING id",
    );
    orgId = Number(organization.rows[0]!.id);
    await pool.query(
      "INSERT INTO org_settings (org_id, gate_enabled) VALUES ($1, true)",
      [orgId],
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
        (github_installation_id, account_login, account_type, org_id)
       VALUES (1002, 'publication', 'Organization', $1)
       RETURNING id`,
      [orgId],
    );
    installationId = Number(installation.rows[0]!.id);
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
        (github_repo_id, installation_id, full_name, private, enabled)
       VALUES (1003, $1, 'publication/repo', false, true)
       RETURNING id`,
      [installation.rows[0]!.id],
    );
    repositoryId = Number(repository.rows[0]!.id);
  }, 30_000);

  afterAll(async () => {
    await pool.end();
      }, orgId);

  test("completion opts a pre-cutover staged review into lifecycle enforcement", async () => {
    const reviewEnvelope = envelope({ head: "3".repeat(40) });
    await pool.query(
      "ALTER TABLE reviews DISABLE TRIGGER reviews_require_publication_lifecycle",
    );
    let reviewId: number;
    try {
      const review = await pool.query<{ id: string }>(
        `INSERT INTO reviews
          (repository_id, pr_number, head_sha, base_sha, status, trigger_source,
           queued_at, started_at, envelope)
         VALUES ($1, 69, $2, $3, 'running', 'unknown', now(), now(), $4::jsonb)
         RETURNING id`,
        [
          repositoryId,
          reviewEnvelope.headSha!,
          reviewEnvelope.baseSha!,
          JSON.stringify(reviewEnvelope),
        ],
      );
      reviewId = Number(review.rows[0]!.id);
    } finally {
      await pool.query(
        "ALTER TABLE reviews ENABLE TRIGGER reviews_require_publication_lifecycle",
      );
    }

    await pool.query(
      "UPDATE reviews SET status = 'completed', finished_at = now() WHERE id = $1",
      [reviewId!],
    );
    const lifecycle = await pool.query<{ required: boolean }>(
      `SELECT publication_lifecycle_required_at IS NOT NULL AS required
         FROM reviews WHERE id = $1`,
      [reviewId!],
    );
    expect(lifecycle.rows[0]?.required).toBe(true);
    await pool.query(
      "UPDATE reviews SET publication_lifecycle_reconciled_at = now() WHERE id = $1",
      [reviewId!],
    );
  });

  test("resumes a staged terminal publication after worker interruption without duplicates", async () => {
    const reviewEnvelope = envelope({ head: "9".repeat(40) });
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source, queued_at, started_at)
       VALUES ($1, 70, $2, $3, 'running', 'unknown', now(), now())
       RETURNING id`,
      [repositoryId, reviewEnvelope.headSha!, "a".repeat(40)],
    );
    const reviewId = Number(review.rows[0]!.id);
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, locked_at, locked_by)
       VALUES ('review', '{"repoFullName":"publication/repo","prNumber":7}', 'running', now(), 'worker-before-restart')
       RETURNING id`,
    );
    const reviewJobId = Number(job.rows[0]!.id);
    const usage = [
      {
        orgId,
        repositoryId,
        promptTokens: 1,
        completionTokens: 1,
        modelUsed: "test/model",
        costMicros: 0,
        billingScope: "analytics" as const,
      },
    ];

    expect(
      await stageReviewCompletionCandidate(
        db,
        {
          reviewId,
          reviewJobId,
          envelope: reviewEnvelope,
          configFiles: [],
          silent: true,
          gateFailing: false,
          publicationReceipt: {
            version: 1,
            receiptId: "github-review-v1:restart",
            findings: [],
          },
        },
        orgId,
      ),
    ).toMatchObject({ staged: true, completed: false });

    const staged = await pool.query<{
      status: string;
      has_envelope: boolean;
      recovery_review_id: string;
      receipts: string;
      usage: string;
    }>(
      `SELECT review.status,
              review.envelope IS NOT NULL AS has_envelope,
              job.payload->>'recoveryReviewId' AS recovery_review_id,
              (SELECT count(*) FROM review_publication_receipts receipt WHERE receipt.review_id = review.id) AS receipts,
              (SELECT count(*) FROM usage_events usage WHERE usage.review_id = review.id) AS usage
         FROM reviews review
         JOIN jobs job ON job.id = $2
        WHERE review.id = $1`,
      [reviewId, reviewJobId],
    );
    expect(staged.rows[0]).toEqual({
      status: "running",
      has_envelope: true,
      recovery_review_id: String(reviewId),
      receipts: "1",
      usage: "0",
    });

    expect(
      await finalizeStagedReviewCompletionWithGateMode(
        db,
        { reviewId, usage, usageAccountingComplete: true },
        orgId,
      ),
    ).toMatchObject({ completed: true });
    expect(
      await finalizeStagedReviewCompletionWithGateMode(
        db,
        { reviewId, usage, usageAccountingComplete: true },
        orgId,
      ),
    ).toMatchObject({ completed: false });

    const terminal = await pool.query<{
      status: string;
      receipts: string;
      usage: string;
      sync_jobs: string;
    }>(
      `SELECT review.status,
              (SELECT count(*) FROM review_publication_receipts receipt WHERE receipt.review_id = review.id) AS receipts,
              (SELECT count(*) FROM usage_events usage WHERE usage.review_id = review.id) AS usage,
              (SELECT count(*) FROM jobs sync WHERE sync.kind = 'gate-state-sync' AND (sync.payload->>'reviewId')::bigint = review.id) AS sync_jobs
         FROM reviews review WHERE review.id = $1`,
      [reviewId],
    );
    expect(terminal.rows[0]).toEqual({
      status: "completed",
      receipts: "1",
      usage: "1",
      sync_jobs: "1",
    });
    await pool.query(
      "UPDATE reviews SET publication_lifecycle_reconciled_at = now() WHERE id = $1",
      [reviewId],
    );
  });

  test.each(["running", "completed"] as const)(
    "worker recovery reconciles a %s staged review before queuing its gate",
    async (status) => {
      const reviewEnvelope = envelope({
        head: status === "running" ? "7".repeat(40) : "8".repeat(40),
      });
      const review = await pool.query<{ id: string; public_id: string }>(
        `INSERT INTO reviews
          (repository_id, pr_number, head_sha, base_sha, status, trigger_source,
           queued_at, started_at, finished_at, envelope,
           publication_lifecycle_reconciled_at,
           source_org_id, source_installation_id,
           source_github_installation_id, source_github_repo_id,
           source_repo_full_name, advisory_check_run_id, gate_check_run_id)
         VALUES
          ($1, 71, $2, $3, $4::review_status, 'unknown', now(), now(),
           CASE WHEN $4::review_status = 'completed' THEN now() ELSE NULL END, $5::jsonb,
           NULL, $6, $7, 1002, 1003, 'publication/repo', 9101, 9102)
         RETURNING id, public_id`,
        [
          repositoryId,
          reviewEnvelope.headSha!,
          reviewEnvelope.baseSha!,
          status,
          JSON.stringify(reviewEnvelope),
          orgId,
          installationId,
        ],
      );
      const reviewId = Number(review.rows[0]!.id);
      const observationCountBefore = recoveryThreadObservationCount;
      const { resumeStagedReviewCompletion } = await import("@/worker/review");

      await expect(
        resumeStagedReviewCompletion({
          db,
          pool,
          payload: {
            installationId: 1002,
            sourceInstallationId: installationId,
            sourceOrgId: orgId,
            githubRepoId: 1003,
            repoFullName: "publication/repo",
            prNumber: 71,
            headSha: reviewEnvelope.headSha!,
            baseSha: reviewEnvelope.baseSha!,
            recoveryReviewId: reviewId,
          },
          installation: { id: installationId, orgId, orgSlug: "publication" },
          repository: {
            id: repositoryId,
            githubRepoId: 1003,
            fullName: "publication/repo",
          },
        }),
      ).resolves.toBe(true);

      const terminal = await pool.query<{
        status: string;
        lifecycle_reconciled: boolean;
        sync_jobs: string;
      }>(
        `SELECT review.status,
                review.publication_lifecycle_reconciled_at IS NOT NULL AS lifecycle_reconciled,
                (SELECT count(*) FROM jobs sync
                  WHERE sync.kind = 'gate-state-sync'
                    AND (sync.payload->>'reviewId')::bigint = review.id) AS sync_jobs
           FROM reviews review WHERE review.id = $1`,
        [reviewId],
      );
      expect(terminal.rows[0]).toEqual({
        status: "completed",
        lifecycle_reconciled: true,
        sync_jobs: "1",
      });
      expect(recoveryThreadObservationCount).toBe(observationCountBefore + 1);
    },
  );

  test("fleet activation preserves legacy reviews and releases only parked gates", async () => {
    const pendingEnvelope = envelope({ head: "6".repeat(40) });
    const pending = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source,
         queued_at, started_at, source_org_id, source_installation_id,
         source_github_installation_id, source_github_repo_id,
         source_repo_full_name, advisory_check_run_id, gate_check_run_id)
       VALUES ($1, 74, $2, $3, 'running', 'unknown', now(), now(),
               $4, $5, 1002, 1003, 'publication/repo', 9201, 9202)
       RETURNING id`,
      [
        repositoryId,
        pendingEnvelope.headSha!,
        pendingEnvelope.baseSha!,
        orgId,
        installationId,
      ],
    );
    const pendingReviewId = Number(pending.rows[0]!.id);
    expect(
      await stageReviewCompletionCandidate(
        db,
        {
          reviewId: pendingReviewId,
          envelope: pendingEnvelope,
          configFiles: [],
          silent: true,
          gateFailing: false,
          publicationReceipt: {
            version: 1,
            receiptId: "github-review-v1:mixed-fleet-recovery",
            findings: [],
          },
        },
        orgId,
      ),
    ).toMatchObject({ staged: true });
    expect(
      await finalizeStagedReviewCompletionWithGateMode(
        db,
        {
          reviewId: pendingReviewId,
          usage: [
            {
              orgId,
              repositoryId,
              promptTokens: 1,
              completionTokens: 1,
              modelUsed: "test/model",
              costMicros: 0,
              billingScope: "analytics",
            },
          ],
          usageAccountingComplete: true,
          queueGateStateSync: false,
        },
        orgId,
      ),
    ).toMatchObject({ completed: true });

    const review = await pool.query<{ id: string; public_id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, started_at,
         finished_at, publication_lifecycle_reconciled_at)
       VALUES ($1, 72, $2, $3, 'completed', now(), now(), NULL)
       RETURNING id, public_id`,
      [repositoryId, "5".repeat(40), "4".repeat(40)],
    );
    const reviewId = Number(review.rows[0]!.id);
    const gate = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload)
       VALUES ('gate-state-sync', jsonb_build_object(
         'reviewId', $1::bigint, 'reviewPublicId', $2::text
       ))
       RETURNING id`,
      [reviewId, review.rows[0]!.public_id],
    );
    const gateId = Number(gate.rows[0]!.id);
    const parkedBefore = await pool.query<{
      parked: boolean;
      dark_marker: boolean;
    }>(
      `SELECT run_after = 'infinity'::timestamptz AS parked,
              payload ? '_postilPublicationLifecycleDark' AS dark_marker
         FROM jobs WHERE id = $1`,
      [gateId],
    );
    expect(parkedBefore.rows[0]).toEqual({ parked: true, dark_marker: true });
    await pool.query(
      `UPDATE jobs
          SET status = 'running', locked_at = now(), locked_by = 'abandoned-cutover'
        WHERE id = $1`,
      [gateId],
    );

    expect(await activatePublicationLifecycleRelease(pool)).toMatchObject({
      activated: true,
      recoveriesQueued: 1,
      runningGatesRecovered: 1,
    });
    expect(await publicationLifecycleReleaseActivated(pool)).toBe(true);
    const activated = await pool.query<{
      lifecycle_reconciled: boolean;
      parked: boolean;
      dark_marker: boolean;
    }>(
      `SELECT review.publication_lifecycle_reconciled_at IS NOT NULL AS lifecycle_reconciled,
              job.run_after = 'infinity'::timestamptz AS parked,
              job.payload ? '_postilPublicationLifecycleDark' AS dark_marker
         FROM reviews review JOIN jobs job ON job.id = $2
        WHERE review.id = $1`,
      [reviewId, gateId],
    );
    expect(activated.rows[0]).toEqual({
      lifecycle_reconciled: false,
      parked: false,
      dark_marker: false,
    });
    const recovery = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM jobs
        WHERE kind = 'review'
          AND status = 'queued'
          AND payload->>'recoveryReviewId' = $1`,
      [String(pendingReviewId)],
    );
    expect(recovery.rows[0]?.count).toBe("1");

    const liveGate = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, locked_at, locked_by)
       VALUES ('gate-state-sync', jsonb_build_object(
         'reviewId', $1::bigint, 'reviewPublicId', $2::text
       ), 'running', now(), 'live-gate-publisher')
       RETURNING id`,
      [reviewId, review.rows[0]!.public_id],
    );
    expect(await activatePublicationLifecycleRelease(pool)).toMatchObject({
      activated: false,
      runningGatesRecovered: 0,
    });
    const repeatedActivation = await pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE id = $1",
      [liveGate.rows[0]!.id],
    );
    expect(repeatedActivation.rows[0]?.status).toBe("running");
    await pool.query(
      `UPDATE jobs
          SET status = 'done', locked_at = NULL, locked_by = NULL
        WHERE id = $1`,
      [liveGate.rows[0]!.id],
    );

    let finishPublication!: () => void;
    const publicationHold = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    let publicationLocked!: () => void;
    const publicationAcquired = new Promise<void>((resolve) => {
      publicationLocked = resolve;
    });
    const publication = withPublicationLifecycleReleaseActive(
      pool,
      async (_lockedDb, lockedClient) => {
        publicationLocked();
        await publicationHold;
        await lockedClient.query(
          `INSERT INTO jobs (kind, payload)
           VALUES ('gate-state-sync', jsonb_build_object(
             'reviewId', $1::bigint, 'reviewPublicId', $2::text
           ))`,
          [reviewId, review.rows[0]!.public_id],
        );
      },
    );
    await publicationAcquired;
    let deactivationFinished = false;
    const deactivation = deactivatePublicationLifecycleRelease(pool).then(
      (result) => {
        deactivationFinished = true;
        return result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deactivationFinished).toBe(false);
    finishPublication();
    await publication;
    await expect(deactivation).resolves.toMatchObject({ deactivated: true });
    const parkedAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM jobs
        WHERE kind = 'gate-state-sync'
          AND payload->>'reviewPublicId' = $1
          AND run_after = 'infinity'::timestamptz`,
      [review.rows[0]!.public_id],
    );
    expect(Number(parkedAfter.rows[0]?.count ?? "0")).toBeGreaterThan(0);
    expect(await activatePublicationLifecycleRelease(pool)).toMatchObject({
      activated: true,
    });
  });

  test("trigger producers park without waiting behind queued deactivation", async () => {
    const transitionPool = new Pool({ connectionString: TEST_URL, max: 3 });
    const reviewId = await createRunningReview("6".repeat(40), null, 74, false);
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      holderAcquired = resolve;
    });
    const holder = withPublicationLifecycleReleaseActive(
      transitionPool,
      async () => {
        holderAcquired();
        await holderReleased;
      },
    );
    await acquired;
    const deactivation = deactivatePublicationLifecycleRelease(transitionPool);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const client = await transitionPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '2s'");
        await client.query(
          "UPDATE reviews SET envelope = $2::jsonb WHERE id = $1",
          [reviewId, JSON.stringify(envelope({ head: "6".repeat(40) }))],
        );
        const gate = await client.query<{ deferred: boolean; dark: boolean }>(
          `INSERT INTO jobs (kind, payload)
           VALUES ('gate-state-sync', jsonb_build_object(
             'reviewId', $1::bigint, 'reviewPublicId', (
               SELECT public_id::text FROM reviews WHERE id = $1
             )
           ))
           RETURNING
             run_after > now()
               AND run_after <= now() + interval '31 seconds' AS deferred,
             payload ? '_postilPublicationLifecycleDark' AS dark`,
          [reviewId],
        );
        await client.query("COMMIT");
        expect(gate.rows[0]).toEqual({ deferred: true, dark: true });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } finally {
      releaseHolder();
      await holder;
      await deactivation;
      await transitionPool.end();
    }
    const lifecycle = await pool.query<{ required: boolean }>(
      `SELECT publication_lifecycle_required_at IS NOT NULL AS required
         FROM reviews WHERE id = $1`,
      [reviewId],
    );
    expect(lifecycle.rows[0]?.required).toBe(true);
    expect(await activatePublicationLifecycleRelease(pool)).toMatchObject({
      activated: true,
    });
  });

  test("queued lifecycle acquisition restores the transaction lock timeout", async () => {
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ('publication-lifecycle-fleet-active')
       ON CONFLICT (name) DO NOTHING`,
    );
    const holderPool = new Pool({ connectionString: TEST_URL, max: 1 });
    const transitionPool = new Pool({ connectionString: TEST_URL, max: 1 });
    const rowLockPool = new Pool({ connectionString: TEST_URL, max: 1 });
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      holderAcquired = resolve;
    });
    const holder = withPublicationLifecycleReleaseActive(
      holderPool,
      async () => {
        holderAcquired();
        await holderReleased;
      },
    );
    const rowLock = await rowLockPool.connect();
    try {
      await acquired;
      await rowLock.query("BEGIN");
      await rowLock.query(
        `SELECT name FROM deployment_capabilities
          WHERE name = 'publication-lifecycle-fleet-active'
          FOR UPDATE`,
      );
      const deactivation = deactivatePublicationLifecycleRelease(
        transitionPool,
      ).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      await Bun.sleep(50);
      releaseHolder();
      await holder;
      await Bun.sleep(400);
      await rowLock.query("COMMIT");

      const outcome = await deactivation;
      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toMatchObject({ deactivated: true });
    } finally {
      releaseHolder();
      await holder.catch(() => undefined);
      await rowLock.query("ROLLBACK").catch(() => undefined);
      rowLock.release();
      await Promise.all([
        holderPool.end(),
        transitionPool.end(),
        rowLockPool.end(),
      ]);
      await activatePublicationLifecycleRelease(pool);
    }
  });

  test("deactivation ignores an idle legacy session lock without terminating its backend", async () => {
    const stalePool = new Pool({
      connectionString: TEST_URL,
      max: 1,
      application_name: "Supavisor",
    });
    const holder = await stalePool.connect();
    try {
      await holder.query(
        "SELECT pg_advisory_lock_shared(hashtextextended($1, 0))",
        ["postil:publication-lifecycle-release"],
      );
      await holder.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        ["postil:test-leaked-session-state"],
      );

      expect(await deactivatePublicationLifecycleRelease(pool)).toMatchObject({
        deactivated: true,
      });
      const leakedState = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid::bigint = (
              (hashtextextended($1, 0) >> 32) & 4294967295
            )
            AND objid::bigint = (hashtextextended($1, 0) & 4294967295)`,
        ["postil:test-leaked-session-state"],
      );
      expect(leakedState.rows[0]?.count).toBe("1");
      expect((await holder.query("SELECT 1 AS alive")).rows[0]?.alive).toBe(1);
    } finally {
      await holder
        .query(
          "SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))",
          ["postil:publication-lifecycle-release"],
        )
        .catch(() => undefined);
      holder.release(true);
      await stalePool.end();
      await activatePublicationLifecycleRelease(pool);
    }
  });

  test("legacy drain does not hold the lifecycle-v2 exclusive lock", async () => {
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ('publication-lifecycle-fleet-active')
       ON CONFLICT (name) DO NOTHING`,
    );
    const legacyJob = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, locked_at, locked_by)
       VALUES (
         'gate-state-sync',
         '{"reviewId":1,"reviewPublicId":"legacy-drain-order"}'::jsonb,
         'running', now(), 'legacy-worker'
       )
       RETURNING id`,
    );
    const deactivation = deactivatePublicationLifecycleRelease(pool);
    const observer = await pool.connect();
    let darkVisible = false;
    let sharedLockAcquired = false;
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const active = await observer.query<{ active: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM deployment_capabilities
              WHERE name = 'publication-lifecycle-fleet-active'
           ) AS active`,
        );
        darkVisible = active.rows[0]?.active === false;
        if (darkVisible) break;
        await Bun.sleep(25);
      }
      await observer.query("BEGIN");
      const probe = await observer.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock_shared(
           hashtextextended($1, 0)
         ) AS acquired`,
        ["postil:publication-lifecycle-release-v2"],
      );
      sharedLockAcquired = probe.rows[0]?.acquired === true;
    } finally {
      await observer.query("ROLLBACK").catch(() => undefined);
      await observer.query(
        `UPDATE jobs
            SET status = 'done', locked_at = NULL, locked_by = NULL
          WHERE id = $1`,
        [legacyJob.rows[0]!.id],
      );
      observer.release();
    }
    await expect(deactivation).resolves.toMatchObject({ deactivated: true });
    expect(darkVisible).toBe(true);
    expect(sharedLockAcquired).toBe(true);
    await activatePublicationLifecycleRelease(pool);
  });

  test("deactivation drains a durable legacy publication operation without trusting backend state", async () => {
    const legacyPool = new Pool({ connectionString: TEST_URL, max: 1 });
    const holder = await legacyPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
        ["postil:publication-lifecycle-release"],
      );
      const legacyJob = await pool.query<{ id: string }>(
        `INSERT INTO jobs
           (kind, payload, status, locked_at, locked_by)
         VALUES
           ('gate-state-sync', '{"reviewId":1,"reviewPublicId":"legacy-drain"}'::jsonb,
            'running', now(), 'legacy-worker')
         RETURNING id`,
      );
      let finished = false;
      const deactivation = deactivatePublicationLifecycleRelease(pool).then(
        (result) => {
          finished = true;
          return result;
        },
      );
      await Bun.sleep(150);
      expect(finished).toBe(false);
      await pool.query(
        `UPDATE jobs
            SET status = 'done', locked_at = NULL, locked_by = NULL
          WHERE id = $1`,
        [legacyJob.rows[0]!.id],
      );
      await expect(deactivation).resolves.toMatchObject({ deactivated: true });
      expect((await holder.query("SELECT 1 AS alive")).rows[0]?.alive).toBe(1);
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await legacyPool.end();
      await activatePublicationLifecycleRelease(pool);
    }
  });

  test("failed release preparation restores the exact fleet capabilities", async () => {
    const releaseSha = "8".repeat(40);
    const priorReleaseSha = "5".repeat(40);
    const capabilityNames = [
      "publication-lifecycle-fleet-active",
      "hosted-inference-fleet-active",
      `hosted-inference-release:${releaseSha}`,
      `hosted-inference-dark:${releaseSha}`,
    ];
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = ANY($1::text[])",
      [capabilityNames],
    );
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ('publication-lifecycle-fleet-active'),
              ('hosted-inference-fleet-active'),
              ($1)`,
      [`hosted-inference-release:${releaseSha}`],
    );
    const gate = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload)
       VALUES ('gate-state-sync', '{"reviewId":1,"reviewPublicId":"release-compensation"}'::jsonb)
       RETURNING id`,
    );

    const snapshot = await prepareManagedReleaseCapabilities(
      pool,
      releaseSha,
      true,
    );
    expect(
      (
        await pool.query<{ name: string }>(
          "SELECT name FROM deployment_capabilities WHERE name = ANY($1::text[]) ORDER BY name",
          [capabilityNames],
        )
      ).rows.map((row) => row.name),
    ).toEqual([`hosted-inference-dark:${releaseSha}`]);
    expect(
      (
        await pool.query<{ parked: boolean }>(
          "SELECT run_after = 'infinity'::timestamptz AS parked FROM jobs WHERE id = $1",
          [gate.rows[0]!.id],
        )
      ).rows[0]?.parked,
    ).toBe(true);

    const parkedHosted = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, run_after)
       VALUES
         ('review', jsonb_build_object('releaseDarkSha', $1::text), 'infinity'::timestamptz),
         ('hosted-provider-key-lifecycle', jsonb_build_object('releaseDarkSha', $1::text), 'infinity'::timestamptz)
       RETURNING id`,
      [priorReleaseSha],
    );

    await restoreManagedReleaseCapabilities(pool, snapshot);
    expect(
      (
        await pool.query<{ name: string }>(
          "SELECT name FROM deployment_capabilities WHERE name = ANY($1::text[]) ORDER BY name",
          [capabilityNames],
        )
      ).rows.map((row) => row.name),
    ).toEqual([
      "hosted-inference-fleet-active",
      `hosted-inference-release:${releaseSha}`,
      "publication-lifecycle-fleet-active",
    ]);
    expect(
      (
        await pool.query<{ due: boolean; dark: boolean }>(
          `SELECT run_after <= now() AS due,
                  payload ? '_postilPublicationLifecycleDark' AS dark
             FROM jobs WHERE id = $1`,
          [gate.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({ due: true, dark: false });
    const restoredHosted = await pool.query<{ due: boolean; dark: boolean }>(
      `SELECT run_after <= now() AS due,
              payload ? 'releaseDarkSha' AS dark
         FROM jobs
        WHERE id = ANY($1::bigint[])
        ORDER BY id`,
      [parkedHosted.rows.map((row) => row.id)],
    );
    expect(restoredHosted.rows).toEqual([
      { due: true, dark: false },
      { due: true, dark: false },
    ]);
    const journal = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM deployment_capabilities
        WHERE name LIKE $1`,
      [`managed-release-preparation:${releaseSha}:%`],
    );
    expect(journal.rows[0]?.count).toBe("0");
  });

  test("the deploy recovery command restores the exact durable preparation", async () => {
    const releaseSha = "7".repeat(40);
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ('publication-lifecycle-fleet-active'),
              ('hosted-inference-fleet-active'),
              ($1)
       ON CONFLICT (name) DO NOTHING`,
      [`hosted-inference-release:${releaseSha}`],
    );
    await prepareManagedReleaseCapabilities(pool, releaseSha, true);

    expect(
      await pendingReleasePreparationTargets({ DATABASE_URL: TEST_URL! }),
    ).toEqual([releaseSha]);

    expect(
      await releasePreparationCleared({ DATABASE_URL: TEST_URL! }),
    ).toBe(false);

    expect(
      await compensateReleasePreparation({
        DATABASE_URL: TEST_URL!,
        POSTIL_RELEASE_SHA: releaseSha,
      }),
    ).toBe(true);
    expect(
      await compensateReleasePreparation({
        DATABASE_URL: TEST_URL!,
        POSTIL_RELEASE_SHA: releaseSha,
      }),
    ).toBe(false);
    const restored = await pool.query<{ name: string }>(
      `SELECT name FROM deployment_capabilities
        WHERE name = ANY($1::text[])
        ORDER BY name`,
      [[
        "publication-lifecycle-fleet-active",
        "hosted-inference-fleet-active",
        `hosted-inference-release:${releaseSha}`,
      ]],
    );
    expect(restored.rows.map((row) => row.name)).toEqual([
      "hosted-inference-fleet-active",
      `hosted-inference-release:${releaseSha}`,
      "publication-lifecycle-fleet-active",
    ]);
    expect(
      await releasePreparationCleared({ DATABASE_URL: TEST_URL! }),
    ).toBe(true);
    expect(
      await pendingReleasePreparationTargets({ DATABASE_URL: TEST_URL! }),
    ).toEqual([]);
  });

  test("same-release process compensation cannot overwrite a replacement generation", async () => {
    const releaseSha = "6".repeat(40);
    const capabilityNames = [
      "publication-lifecycle-fleet-active",
      "hosted-inference-fleet-active",
      `hosted-inference-release:${releaseSha}`,
      `hosted-inference-dark:${releaseSha}`,
    ];
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = ANY($1::text[])",
      [capabilityNames],
    );
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ('publication-lifecycle-fleet-active'),
              ('hosted-inference-fleet-active'),
              ($1)`,
      [`hosted-inference-release:${releaseSha}`],
    );
    const original = await prepareManagedReleaseCapabilities(
      pool,
      releaseSha,
      true,
    );
    expect(
      await restoreManagedReleasePreparation(
        pool,
        releaseSha,
        original.generation,
      ),
    ).toBe(true);
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = ANY($1::text[])",
      [capabilityNames],
    );
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ('hosted-inference-fleet-active')`,
    );
    const replacement = await prepareManagedReleaseCapabilities(
      pool,
      releaseSha,
      true,
    );

    await restoreManagedReleaseCapabilities(pool, original);
    const stillDark = await pool.query<{ name: string }>(
      `SELECT name FROM deployment_capabilities
        WHERE name = ANY($1::text[])
        ORDER BY name`,
      [capabilityNames],
    );
    expect(stillDark.rows.map((row) => row.name)).toEqual([
      `hosted-inference-dark:${releaseSha}`,
    ]);
    expect(
      await restoreManagedReleasePreparation(
        pool,
        releaseSha,
        replacement.generation,
      ),
    ).toBe(true);
    await activatePublicationLifecycleRelease(pool);
  });

  test("a newer preparation adopts and replaces every superseded journal", async () => {
    const firstRelease = "4".repeat(40);
    const secondRelease = "3".repeat(40);
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ('publication-lifecycle-fleet-active'),
              ('hosted-inference-fleet-active')
       ON CONFLICT (name) DO NOTHING`,
    );
    const gate = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload)
       VALUES ('gate-state-sync', '{"reviewId":1,"reviewPublicId":"atomic-adoption"}'::jsonb)
       RETURNING id`,
    );
    const first = await prepareManagedReleaseCapabilities(
      pool,
      firstRelease,
      true,
    );
    await pool.query(
      "DROP TRIGGER IF EXISTS test_pause_replacement_journal ON deployment_capabilities",
    );
    await pool.query("DROP FUNCTION IF EXISTS test_pause_replacement_journal()");
    await pool.query(`
      CREATE FUNCTION test_pause_replacement_journal()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name LIKE 'managed-release-preparation:${secondRelease}:%:root' THEN
          PERFORM pg_sleep(0.75);
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await pool.query(`
      CREATE TRIGGER test_pause_replacement_journal
      BEFORE INSERT ON deployment_capabilities
      FOR EACH ROW EXECUTE FUNCTION test_pause_replacement_journal()
    `);
    let second!: Awaited<ReturnType<typeof prepareManagedReleaseCapabilities>>;
    try {
      const replacement = prepareManagedReleaseCapabilities(
        pool,
        secondRelease,
        true,
      );
      let barrierReached = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const barrier = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE pid <> pg_backend_pid()
                AND state = 'active'
                AND wait_event = 'PgSleep'
                AND query LIKE '%ON CONFLICT (name) DO UPDATE SET activated_at = now()%'
           ) AS waiting`,
        );
        barrierReached = barrier.rows[0]?.waiting === true;
        if (barrierReached) break;
        await Bun.sleep(25);
      }
      const visibleDuringAdoption = await pool.query<{ name: string }>(
        `SELECT name FROM deployment_capabilities
          WHERE name = ANY($1::text[])
             OR name LIKE 'managed-release-preparation:%:root'
          ORDER BY name`,
        [[
          "publication-lifecycle-fleet-active",
          "hosted-inference-fleet-active",
        ]],
      );
      expect(barrierReached).toBe(true);
      expect(visibleDuringAdoption.rows.map((row) => row.name)).toEqual([
        `managed-release-preparation:${firstRelease}:${first.generation}:root`,
      ]);
      const gateDuringAdoption = await pool.query<{
        parked: boolean;
        dark: boolean;
      }>(
        `SELECT run_after = 'infinity'::timestamptz AS parked,
                payload ? '_postilPublicationLifecycleDark' AS dark
           FROM jobs WHERE id = $1`,
        [gate.rows[0]!.id],
      );
      expect(gateDuringAdoption.rows[0]).toEqual({ parked: true, dark: true });
      second = await replacement;
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS test_pause_replacement_journal ON deployment_capabilities",
      );
      await pool.query("DROP FUNCTION IF EXISTS test_pause_replacement_journal()");
    }
    expect(second.capabilities).toEqual([
      "hosted-inference-fleet-active",
      "publication-lifecycle-fleet-active",
    ]);
    const pending = await pool.query<{ name: string }>(
      `SELECT name FROM deployment_capabilities
        WHERE name LIKE 'managed-release-preparation:%:root'`,
    );
    expect(pending.rows.map((row) => row.name)).toEqual([
      `managed-release-preparation:${secondRelease}:${second.generation}:root`,
    ]);
    expect(
      await restoreManagedReleasePreparation(
        pool,
        secondRelease,
        second.generation,
      ),
    ).toBe(true);
    const restoredGate = await pool.query<{ due: boolean; dark: boolean }>(
      `SELECT run_after <= now() AS due,
              payload ? '_postilPublicationLifecycleDark' AS dark
         FROM jobs WHERE id = $1`,
      [gate.rows[0]!.id],
    );
    expect(restoredGate.rows[0]).toEqual({ due: true, dark: false });
    await activatePublicationLifecycleRelease(pool);
  });

  test("a gate committed after the activation sweep self-heals", async () => {
    await deactivatePublicationLifecycleRelease(pool);
    const activationClient = await pool.connect();
    let lateGateId = 0;
    try {
      await activationClient.query("BEGIN");
      await activationClient.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["postil:publication-lifecycle-release-v2"],
      );
      await activationClient.query(
        `INSERT INTO deployment_capabilities (name)
         VALUES ('publication-lifecycle-fleet-active')
         ON CONFLICT (name) DO NOTHING`,
      );
      await activationClient.query(
        `UPDATE jobs
            SET run_after = now(),
                payload = payload - '_postilPublicationLifecycleDark'
          WHERE kind = 'gate-state-sync'
            AND status = 'queued'
            AND payload ? '_postilPublicationLifecycleDark'`,
      );
      const lateGate = await pool.query<{
        id: string;
        deferred: boolean;
        dark: boolean;
      }>(
        `INSERT INTO jobs (kind, payload)
         VALUES ('gate-state-sync', jsonb_build_object(
           'reviewId', 1, 'reviewPublicId', '00000000-0000-4000-8000-000000000001'
         ))
         RETURNING id,
           run_after > now()
             AND run_after <= now() + interval '31 seconds' AS deferred,
           payload ? '_postilPublicationLifecycleDark' AS dark`,
      );
      lateGateId = Number(lateGate.rows[0]!.id);
      expect(lateGate.rows[0]).toMatchObject({ deferred: true, dark: true });
      await activationClient.query("COMMIT");
    } catch (error) {
      await activationClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      activationClient.release();
    }
    const converged = await pool.query<{ due: boolean; dark: boolean }>(
      `UPDATE jobs SET run_after = now()
        WHERE id = $1
        RETURNING run_after <= now() AS due,
          payload ? '_postilPublicationLifecycleDark' AS dark`,
      [lateGateId],
    );
    expect(converged.rows[0]).toEqual({ due: true, dark: false });
    await activatePublicationLifecycleRelease(pool);
  });

  test("pull-request decision lock blocks a newer staged recurrence", async () => {
    const firstId = await createRunningReview("4".repeat(40), null, 73, false);
    const secondId = await createRunningReview(
      "5".repeat(40),
      "4".repeat(40),
      73,
      false,
    );
    await pool.query(
      `UPDATE reviews SET publication_lifecycle_reconciled_at = NULL
        WHERE id = ANY($1::bigint[])`,
      [[firstId, secondId]],
    );
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const locked = withReviewDecisionScopeLock(pool, firstId, async () => {
      lockAcquired();
      await holdLock;
    });
    await acquired;

    let staged = false;
    const staging = stageReviewCompletionCandidate(
      db,
      {
        reviewId: secondId,
        envelope: envelope({ head: "5".repeat(40), findings: [finding("race-id")] }),
        configFiles: [],
        silent: false,
        gateFailing: false,
        publicationReceipt: {
          version: 1,
          receiptId: "github-review-v1:lock-race",
          findings: [
            {
              findingId: "race-id",
              stableIdentity: true,
              initialOutcome: "inline",
              inlineRejected: false,
              commentId: "8100",
            },
          ],
        },
      },
      orgId,
    ).then((result) => {
      staged = result.staged;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(staged).toBe(false);

    releaseLock();
    await locked;
    await expect(staging).resolves.toMatchObject({ staged: true });
  });

  test("persists exact initial channels and reconciles later carried and resolved states", async () => {
    const firstId = await createRunningReview("b".repeat(40));
    await complete(
      firstId,
      envelope({
        head: "b".repeat(40),
        findings: [finding("inline-id"), finding("summary-id"), finding("resolved-id")],
      }),
      {
        version: 1,
        receiptId: "github-review-v1:first",
        reviewId: "9001",
        findings: [
          {
            findingId: "inline-id",
            stableIdentity: true,
            initialOutcome: "inline",
            inlineRejected: false,
            commentId: "8001",
          },
          {
            findingId: "summary-id",
            stableIdentity: true,
            initialOutcome: "summaryOnly",
            inlineRejected: false,
          },
          {
            findingId: "resolved-id",
            stableIdentity: true,
            initialOutcome: "inline",
            inlineRejected: false,
            commentId: "8002",
          },
        ],
      },
    );

    const secondId = await createRunningReview("c".repeat(40), "b".repeat(40));
    await complete(
      secondId,
      envelope({
        head: "c".repeat(40),
        since: "b".repeat(40),
        findings: [finding("inline-id", "[carried from previous review]\n\nA complete finding body.")],
        resolved: [finding("summary-id"), finding("resolved-id")],
      }),
      {
        version: 1,
        receiptId: "github-review-v1:second",
        findings: [
          {
            findingId: "inline-id",
            stableIdentity: true,
            initialOutcome: "carried",
            inlineRejected: false,
          },
          {
            findingId: "summary-id",
            stableIdentity: true,
            initialOutcome: "resolved",
            inlineRejected: false,
          },
          {
            findingId: "resolved-id",
            stableIdentity: true,
            initialOutcome: "resolved",
            inlineRejected: false,
          },
        ],
      },
    );

    const rows = await pool.query<{
      finding_id: string;
      initial_state: string;
      current_state: string;
    }>(
      `SELECT finding_id, initial_state, current_state
       FROM finding_publications WHERE review_id = $1 ORDER BY finding_id`,
      [firstId],
    );
    expect(rows.rows).toEqual([
      { finding_id: "inline-id", initial_state: "inline", current_state: "carried" },
      { finding_id: "resolved-id", initial_state: "inline", current_state: "resolved" },
      { finding_id: "summary-id", initial_state: "summaryOnly", current_state: "resolved" },
    ]);

    expect(
      await getPullRequestPublicationThreadPlan(db, repositoryId, 7),
    ).toEqual({
      commentIds: ["8001", "8002"],
      resolveCommentIds: ["8002"],
    });

    await pool.query("UPDATE reviews SET status = 'running' WHERE id = $1", [secondId]);
    expect(
      await getPullRequestPublicationThreadPlan(db, repositoryId, 7),
    ).toEqual({
      commentIds: ["8001", "8002"],
      resolveCommentIds: [],
    });
    await pool.query("UPDATE reviews SET status = 'completed' WHERE id = $1", [secondId]);

    await applyPublicationThreadObservations(db, [
      { githubCommentId: "8002", state: "outdated" },
    ]);
    expect(
      await getPullRequestPublicationThreadPlan(db, repositoryId, 7),
    ).toEqual({
      commentIds: ["8001", "8002"],
      resolveCommentIds: ["8002"],
    });

    await applyPublicationThreadObservations(db, [
      { githubCommentId: "8001", state: "inline" },
    ]);
    expect(
      (
        await pool.query<{ current_state: string }>(
          "SELECT current_state FROM finding_publications WHERE review_id = $1 AND finding_id = 'inline-id'",
          [firstId],
        )
      ).rows[0]?.current_state,
    ).toBe("carried");

    const thirdId = await createRunningReview("d".repeat(40), "c".repeat(40));
    await complete(
      thirdId,
      envelope({
        head: "d".repeat(40),
        since: "c".repeat(40),
        findings: [finding("resolved-id")],
      }),
      {
        version: 1,
        receiptId: "github-review-v1:third",
        reviewId: "9002",
        findings: [
          {
            findingId: "resolved-id",
            stableIdentity: true,
            initialOutcome: "inline",
            inlineRejected: false,
            commentId: "8003",
          },
        ],
      },
    );
    expect(
      await getPullRequestPublicationThreadPlan(db, repositoryId, 7),
    ).toEqual({
      commentIds: ["8001", "8002", "8003"],
      resolveCommentIds: [],
    });

    await pool.query(
      `UPDATE reviews
          SET queued_at = CASE
            WHEN id = $1 THEN timestamp '2026-08-27 10:00:00+00'
            WHEN id = $2 THEN timestamp '2026-08-27 11:00:00+00'
            ELSE timestamp '2026-08-27 09:00:00+00'
          END
        WHERE id = ANY($3::bigint[])`,
      [thirdId, secondId, [firstId, secondId, thirdId]],
    );
    expect(
      await getPullRequestPublicationThreadPlan(db, repositoryId, 7),
    ).toEqual({
      commentIds: ["8001", "8002", "8003"],
      resolveCommentIds: ["8002", "8003"],
    });
    await pool.query(
      `UPDATE reviews
          SET queued_at = now() + CASE
            WHEN id = $1 THEN interval '-1 minute'
            WHEN id = $2 THEN interval '-2 minutes'
            ELSE interval '-3 minutes'
          END
        WHERE id = ANY($3::bigint[])`,
      [thirdId, secondId, [firstId, secondId, thirdId]],
    );

    await pool.query("UPDATE reviews SET status = 'running' WHERE id = $1", [thirdId]);
    expect(
      await getPullRequestPublicationThreadPlan(db, repositoryId, 7),
    ).toEqual({
      commentIds: ["8001", "8002", "8003"],
      resolveCommentIds: [],
    });
    await pool.query("UPDATE reviews SET status = 'failed' WHERE id = $1", [thirdId]);
    expect(
      await getPullRequestPublicationThreadPlan(db, repositoryId, 7),
    ).toEqual({
      commentIds: ["8001", "8002", "8003"],
      resolveCommentIds: [],
    });

    await applyPublicationThreadObservations(db, [
      { githubCommentId: "8002", state: "deleted" },
    ]);
    const fourthId = await createRunningReview("e".repeat(40), "d".repeat(40));
    await complete(
      fourthId,
      envelope({
        head: "e".repeat(40),
        since: "d".repeat(40),
        resolved: [finding("resolved-id")],
      }),
      {
        version: 1,
        receiptId: "github-review-v1:fourth",
        findings: [
          {
            findingId: "resolved-id",
            stableIdentity: true,
            initialOutcome: "resolved",
            inlineRejected: false,
          },
        ],
      },
    );
    expect(
      await getPullRequestPublicationThreadPlan(db, repositoryId, 7),
    ).toEqual({
      commentIds: ["8001", "8002", "8003"],
      resolveCommentIds: ["8002", "8003"],
    });

    await expect(
      pool.query(
        "UPDATE finding_publications SET initial_state = 'unknown' WHERE review_id = $1 AND finding_id = 'inline-id'",
        [firstId],
      ),
    ).rejects.toThrow("immutable");
  });

  test.each([".postil/provider", ".postil/model-output"])(
    "does not persist %s receipt entries as finding lifecycle rows",
    async (operationalPath) => {
      const reviewId = await createRunningReview("d".repeat(40));
      const publishedFinding = finding("published-id");
      const operationalFinding = {
        ...finding("operational-id"),
        path: operationalPath,
      };

      await complete(
        reviewId,
        envelope({
          head: "d".repeat(40),
          findings: [publishedFinding, operationalFinding],
        }),
        {
          version: 1,
          receiptId: "forge-review-v1:operational",
          findings: [
            {
              findingId: "published-id",
              stableIdentity: true,
              initialOutcome: "inline",
              inlineRejected: false,
            },
            {
              findingId: "operational-id",
              stableIdentity: true,
              initialOutcome: "unknown",
              inlineRejected: false,
            },
          ],
        },
      );

      const rows = await pool.query<{ finding_id: string }>(
        "SELECT finding_id FROM finding_publications WHERE review_id = $1 ORDER BY finding_id",
        [reviewId],
      );
      expect(rows.rows).toEqual([{ finding_id: "published-id" }]);
    },
  );

  test("authoritative observations produce resolved, outdated, and deleted lifecycle states", async () => {
    const firstId = reviewIds[0]!;
    await applyPublicationThreadObservations(db, [
      { githubCommentId: "8001", state: "outdated" },
    ]);
    expect(
      (
        await pool.query<{ current_state: string }>(
          "SELECT current_state FROM finding_publications WHERE review_id = $1 AND finding_id = 'inline-id'",
          [firstId],
        )
      ).rows[0]?.current_state,
    ).toBe("outdated");
    await applyPublicationThreadObservations(db, [
      { githubCommentId: "8001", state: "resolved" },
      { githubCommentId: "8001", state: "deleted" },
    ]);
    expect(
      (
        await pool.query<{ current_state: string }>(
          "SELECT current_state FROM finding_publications WHERE review_id = $1 AND finding_id = 'inline-id'",
          [firstId],
        )
      ).rows[0]?.current_state,
    ).toBe("deleted");
  });

  test("records deployed CLI reviews as legacy unknown and dashboard counts use publication state", async () => {
    const legacyId = await createRunningReview("d".repeat(40), "c".repeat(40));
    await complete(
      legacyId,
      envelope({ head: "d".repeat(40), findings: [finding("legacy-id")] }),
    );
    const counts = await getReviewPublicationCounts(db, reviewIds);
    expect(counts.get(legacyId)?.unknown).toBe(1);

    const dashboardRows = await getOrgReviewRows(db, orgId, 20);
    expect(dashboardRows.find((row) => row.id === legacyId)).toMatchObject({
      findingsCount: null,
    });
    expect(dashboardRows.find((row) => row.id === reviewIds[1])).toMatchObject({
      findingsCount: 1,
    });
  });

  test("persists version 2 check-annotation identity and dashboard counts", async () => {
    const annotationId = await createRunningReview("e".repeat(40), "d".repeat(40));
    await complete(
      annotationId,
      envelope({
        head: "e".repeat(40),
        findings: [finding("annotation-id")],
      }),
      {
        version: 2,
        channel: "checkAnnotations",
        receiptId: "github-review-v2:annotation",
        findings: [
          {
            findingId: "annotation-id",
            stableIdentity: true,
            initialOutcome: "checkAnnotation",
            inlineRejected: false,
          },
        ],
      },
    );

    const receipt = await pool.query<{
      receipt_version: number;
      publication_channel: string;
      github_review_id: string | null;
    }>(
      `SELECT receipt_version, publication_channel, github_review_id
       FROM review_publication_receipts WHERE review_id = $1`,
      [annotationId],
    );
    expect(receipt.rows).toEqual([
      {
        receipt_version: 2,
        publication_channel: "checkAnnotations",
        github_review_id: null,
      },
    ]);
    const counts = await getReviewPublicationCounts(db, [annotationId]);
    expect(counts.get(annotationId)?.checkAnnotation).toBe(1);
    expect(
      (await getOrgReviewRows(db, orgId, 20)).find((row) => row.id === annotationId),
    ).toMatchObject({ findingsCount: 1 });
    await expect(
      pool.query(
        "UPDATE review_publication_receipts SET publication_channel = 'reviewComments' WHERE review_id = $1",
        [annotationId],
      ),
    ).rejects.toThrow("immutable");
  });

  test("persists version 2 file-level comment identity and dashboard counts", async () => {
    const reviewId = await createRunningReview("1".repeat(40), "e".repeat(40));
    await complete(
      reviewId,
      envelope({
        head: "1".repeat(40),
        findings: [finding("file-comment-id")],
      }),
      {
        version: 2,
        channel: "reviewComments",
        receiptId: "github-review-v2:file-comment",
        reviewId: "9005",
        findings: [
          {
            findingId: "file-comment-id",
            stableIdentity: true,
            initialOutcome: "fileComment",
            inlineRejected: false,
            commentId: "8005",
          },
        ],
      },
    );

    expect(
      (
        await pool.query<{
          initial_state: string;
          current_state: string;
          github_comment_id: string;
        }>(
          `SELECT initial_state, current_state, github_comment_id
             FROM finding_publications WHERE review_id = $1`,
          [reviewId],
        )
      ).rows,
    ).toEqual([
      {
        initial_state: "fileComment",
        current_state: "fileComment",
        github_comment_id: "8005",
      },
    ]);
    const counts = await getReviewPublicationCounts(db, [reviewId]);
    expect(counts.get(reviewId)?.fileComment).toBe(1);
    expect(
      (await getOrgReviewRows(db, orgId, 20)).find((row) => row.id === reviewId),
    ).toMatchObject({ findingsCount: 1 });
    const dashboardMetrics = await db.execute(sql<{
      confidences: number[];
      shipped: number;
    }>`
      SELECT
        ARRAY(
          SELECT (entry ->> 'confidence')::double precision
          FROM reviews dashboard_review,
               jsonb_array_elements(COALESCE(dashboard_review.envelope -> 'findings', '[]'::jsonb)) entry
          WHERE dashboard_review.id = ${reviewId}
            AND EXISTS (
              SELECT 1
              FROM finding_publications publication
              WHERE publication.review_id = dashboard_review.id
                AND publication.finding_id = entry ->> 'id'
                AND ${shippedPublicationStateSql(sql.raw("publication.initial_state"))}
            )
        ) AS confidences,
        (
          SELECT count(*)::int
          FROM finding_publications publication
          INNER JOIN reviews published_review ON published_review.id = publication.review_id
          INNER JOIN repositories published_repository ON published_repository.id = published_review.repository_id
          INNER JOIN installations published_installation ON published_installation.id = published_repository.installation_id
          WHERE published_installation.org_id = ${orgId}
            AND published_review.id = ${reviewId}
            AND published_review.status = 'completed'
            AND ${shippedPublicationStateSql(sql.raw("publication.initial_state"))}
        ) AS shipped
    `);
    expect(dashboardMetrics.rows).toEqual([{ confidences: [0.8], shipped: 1 }]);

    await applyPublicationThreadObservations(db, [
      { githubCommentId: "8005", state: "inline" },
    ]);
    expect(
      (
        await pool.query<{ current_state: string }>(
          "SELECT current_state FROM finding_publications WHERE review_id = $1",
          [reviewId],
        )
      ).rows[0]?.current_state,
    ).toBe("fileComment");

    await applyPublicationThreadObservations(db, [
      { githubCommentId: "8005", state: "deleted" },
    ]);
    expect(
      (
        await pool.query<{ current_state: string }>(
          "SELECT current_state FROM finding_publications WHERE review_id = $1",
          [reviewId],
        )
      ).rows[0]?.current_state,
    ).toBe("deleted");

    const invalidReviewId = await createRunningReview(
      "2".repeat(40),
      "1".repeat(40),
    );
    await expect(
      pool.query(
        `INSERT INTO finding_publications
          (review_id, finding_id, stable_identity, initial_state, current_state)
         VALUES ($1, 'missing-file-comment-id', true, 'fileComment', 'fileComment')`,
        [invalidReviewId],
      ),
    ).rejects.toThrow("finding_publications_file_comment_identity_check");
    await expect(
      pool.query(
        `INSERT INTO finding_publications
          (review_id, finding_id, stable_identity, initial_state, current_state)
         VALUES ($1, 'missing-current-file-comment-id', true, 'inline', 'fileComment')`,
        [invalidReviewId],
      ),
    ).rejects.toThrow("finding_publications_file_comment_identity_check");
  });

  test("rejects a version 2 receipt without a publication channel", async () => {
    const reviewId = await createRunningReview("f".repeat(40), "e".repeat(40));
    await expect(
      pool.query(
        `INSERT INTO review_publication_receipts
          (review_id, receipt_version, receipt_id, publication_channel)
         VALUES ($1, 2, 'github-review-v2:missing-channel', NULL)`,
        [reviewId],
      ),
    ).rejects.toThrow("review_publication_receipts_identity_check");
  });
});
