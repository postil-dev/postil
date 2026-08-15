import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/lib/db/schema";
import { GateBadge, ReviewStatusBadge } from "@/components/review-status";
import type { Envelope, Finding } from "@/lib/envelope";
import {
  insertFindingApproval,
  revokeFindingApproval,
} from "@/lib/finding-approvals";
import {
  getOrgReviewRows,
  shippedPublicationStateSql,
} from "@/lib/org-reviews";
import {
  applyPublicationThreadObservations,
  getPullRequestPublicationCommentIds,
  getReviewPublicationCounts,
  reconcilePublicationThreadObservations,
  type PublicationReceipt,
} from "@/lib/publication-receipt";
import {
  finalizeStagedReviewCompletionWithGateMode,
  persistReviewCompletionWithGateMode,
  stageReviewCompletionCandidate,
  type StagedReviewCompletionInput,
} from "@/lib/review-completion";
import { QUEUE_LOCK_GENERATION_CAPABILITY } from "@/lib/release-job-rollout";
import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";

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

function operationalEnvelope(head: string): Envelope {
  return {
    ...envelope({ head }),
    summary: "No reviewer verdict exists because execution failed.",
    silent: false,
    findings: [
      {
        id: `operational-${head.slice(0, 8)}`,
        path: ".postil/provider",
        line: 1,
        severity: "error",
        kind: "uncertainty",
        confidence: 1,
        title: "Review provider unavailable",
        body: "The review provider did not return a usable result.",
      },
    ],
    counts: {
      info: 0,
      warn: 0,
      error: 1,
      suppressed: 0,
      ungrounded: 0,
    },
    confidenceBuckets: [0, 0, 0, 0, 1],
    gate: { failOn: "error", failing: true },
  };
}

describeDb("publication receipt migration and lifecycle", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let orgId = 0;
  let sourceInstallationId = 0;
  let repositoryId = 0;
  const reviewIds: number[] = [];
  let firstPublicationReviewId = 0;
  let secondPublicationReviewId = 0;

  async function createRunningReview(
    headSha: string,
    sinceSha: string | null = null,
    trackForLifecycleAssertions = true,
  ) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, since_sha, status, trigger_source, queued_at, started_at)
       VALUES ($1, 7, $2, $3, $4, 'running', 'unknown', now(), now())
       RETURNING id`,
      [repositoryId, headSha, "a".repeat(40), sinceSha],
    );
    const id = Number(result.rows[0]!.id);
    if (trackForLifecycleAssertions) reviewIds.push(id);
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
    database = await createEphemeralDatabase("publication_receipt");
    pool = database.pool;
    db = drizzle(pool, { schema });
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
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
    sourceInstallationId = Number(installation.rows[0]!.id);
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
    await database?.drop();
  }, 30_000);

  test("rejects receipt deferral through ordinary review staging", async () => {
    const controllerOnlyInput = {
      deferPublicationReceipt: true,
    } as unknown as StagedReviewCompletionInput;
    await expect(
      stageReviewCompletionCandidate(db, controllerOnlyInput, orgId),
    ).rejects.toThrow(
      "publication receipt deferral requires atomic controller staging",
    );
  });

  test("resumes a staged terminal publication after worker interruption without duplicates", async () => {
    const reviewEnvelope = envelope({ head: "9".repeat(40) });
    const expectedReviewInput = {
      installationId: 1002,
      sourceInstallationId,
      sourceOrgId: orgId,
      githubRepoId: 1003,
      repoFullName: "publication/repo",
      prNumber: 70,
      headSha: reviewEnvelope.headSha!,
      baseSha: "a".repeat(40),
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:05.000Z",
    };
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source, queued_at, started_at)
       VALUES ($1, 70, $2, $3, 'running', 'unknown', now(), now())
       RETURNING id`,
      [repositoryId, reviewEnvelope.headSha!, "a".repeat(40)],
    );
    const reviewId = Number(review.rows[0]!.id);
    const job = await pool.query<{
      id: string;
      locked_by: string;
      lock_generation: string;
      payload: typeof expectedReviewInput & { reviewInputSequence: string };
    }>(
      `INSERT INTO jobs
         (kind, payload, status, locked_at, locked_by, lock_generation)
       VALUES
         ('review', $1, 'running', now(), 'worker-before-restart', 1)
       RETURNING id, locked_by, lock_generation::text, payload`,
      [JSON.stringify(expectedReviewInput)],
    );
    const reviewJobId = Number(job.rows[0]!.id);
    const reviewJobLease = {
      id: reviewJobId,
      lockedBy: job.rows[0]!.locked_by,
      lockGeneration: BigInt(job.rows[0]!.lock_generation),
    };
    const staleCleanup = {
      reviewId,
      installationId: 1002,
      repoFullName: "publication/repo",
      advisoryCheckRunId: null,
      gateCheckRunId: null,
      headSha: reviewEnvelope.headSha!,
      advisoryCheckExternalId: `postil:${reviewId}:review`,
      gateCheckExternalId: `postil:${reviewId}:gate`,
      advisoryCheckRunMayExist: false,
      gateCheckRunMayExist: false,
      message: "superseded during publication verification",
      intent: "neutralize" as const,
    };
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
          reviewJobLease,
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
        {
          reviewId,
          usage,
          usageAccountingComplete: true,
          reviewJobLease,
          expectedReviewInput: job.rows[0]!.payload,
          staleCleanup,
        },
        orgId,
      ),
    ).toMatchObject({ completed: true });
    expect(
      await finalizeStagedReviewCompletionWithGateMode(
        db,
        {
          reviewId,
          usage,
          usageAccountingComplete: true,
          reviewJobLease,
          expectedReviewInput: job.rows[0]!.payload,
          staleCleanup,
        },
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
  });

  test("staging rejects an immediate same-owner stale generation atomically", async () => {
    const reviewEnvelope = envelope({ head: "8".repeat(40) });
    const reviewId = await createRunningReview(reviewEnvelope.headSha!);
    const job = await pool.query<{
      id: string;
      locked_at: Date;
      locked_by: string;
      lock_generation: string;
    }>(
      `INSERT INTO jobs
         (kind, payload, status, locked_at, locked_by, lock_generation)
       VALUES
         ('review', '{"repoFullName":"publication/repo","prNumber":8}',
          'running', clock_timestamp(), 'reused-completion-worker', 1)
       RETURNING id, locked_at, locked_by, lock_generation::text`,
    );
    const jobId = Number(job.rows[0]!.id);
    const staleLease = {
      id: jobId,
      lockedBy: job.rows[0]!.locked_by,
      lockGeneration: BigInt(job.rows[0]!.lock_generation),
    };
    await pool.query(
      `UPDATE jobs
          SET status = 'queued', locked_at = NULL, locked_by = NULL
        WHERE id = $1`,
      [jobId],
    );
    const reclaimed = await pool.query<{ lock_generation: string }>(
      `UPDATE jobs
          SET status = 'running', locked_by = $2, locked_at = $3,
              lock_generation = lock_generation + 1
        WHERE id = $1
        RETURNING lock_generation::text`,
      [jobId, staleLease.lockedBy, job.rows[0]!.locked_at],
    );
    const currentLease = {
      ...staleLease,
      lockGeneration: BigInt(reclaimed.rows[0]!.lock_generation),
    };
    const stagedInput = {
      reviewId,
      envelope: reviewEnvelope,
      configFiles: [],
      silent: true,
      gateFailing: false,
      publicationReceipt: {
        version: 1 as const,
        receiptId: "github-review-v1:exact-completion-lease",
        findings: [],
      },
    };

    expect(
      await stageReviewCompletionCandidate(
        db,
        { ...stagedInput, reviewJobLease: staleLease },
        orgId,
      ),
    ).toMatchObject({ staged: false, completed: false });
    const rejected = await pool.query<{
      has_envelope: boolean;
      recovery_review_id: string | null;
      receipts: string;
    }>(
      `SELECT review.envelope IS NOT NULL AS has_envelope,
              job.payload->>'recoveryReviewId' AS recovery_review_id,
              (SELECT count(*)::text
                 FROM review_publication_receipts receipt
                WHERE receipt.review_id = review.id) AS receipts
         FROM reviews review
         JOIN jobs job ON job.id = $2
        WHERE review.id = $1`,
      [reviewId, jobId],
    );
    expect(rejected.rows[0]).toEqual({
      has_envelope: false,
      recovery_review_id: null,
      receipts: "0",
    });

    expect(
      await stageReviewCompletionCandidate(
        db,
        { ...stagedInput, reviewJobLease: currentLease },
        orgId,
      ),
    ).toMatchObject({ staged: true, completed: false });
  });

  test("operational envelopes retain diagnostics but render failed with a policy-sensitive gate", async () => {
    try {
      for (const gateEnabled of [true, false]) {
        await pool.query(
          "UPDATE org_settings SET gate_enabled = $2 WHERE org_id = $1",
          [orgId, gateEnabled],
        );
        const reviewEnvelope = operationalEnvelope(
          (gateEnabled ? "d" : "e").repeat(40),
        );
        const reviewId = await createRunningReview(
          reviewEnvelope.headSha,
          null,
          false,
        );
        const expectedReviewInput = {
          installationId: 1002,
          sourceInstallationId,
          sourceOrgId: orgId,
          githubRepoId: 1003,
          repoFullName: "publication/repo",
          prNumber: 7,
          headSha: reviewEnvelope.headSha!,
          baseSha: "a".repeat(40),
          expectedPullRequestUpdatedAt: "2026-08-10T00:00:05.000Z",
        };
        const job = await pool.query<{
          id: string;
          locked_by: string;
          lock_generation: string;
          payload: typeof expectedReviewInput & { reviewInputSequence: string };
        }>(
          `INSERT INTO jobs
             (kind, payload, status, locked_at, locked_by, lock_generation)
           VALUES ('review', $1, 'running', now(), 'operational-test-worker', 1)
           RETURNING id, locked_by, lock_generation::text, payload`,
          [JSON.stringify(expectedReviewInput)],
        );
        const reviewJobLease = {
          id: Number(job.rows[0]!.id),
          lockedBy: job.rows[0]!.locked_by,
          lockGeneration: BigInt(job.rows[0]!.lock_generation),
        };
        const staleCleanup = {
          reviewId,
          installationId: 1002,
          repoFullName: "publication/repo",
          advisoryCheckRunId: null,
          gateCheckRunId: null,
          headSha: reviewEnvelope.headSha!,
          advisoryCheckExternalId: `postil:${reviewId}:review`,
          gateCheckExternalId: `postil:${reviewId}:gate`,
          advisoryCheckRunMayExist: false,
          gateCheckRunMayExist: false,
          message: "superseded during publication verification",
          intent: "neutralize" as const,
        };
        expect(
          await stageReviewCompletionCandidate(
            db,
            {
              reviewId,
              reviewJobLease,
              envelope: reviewEnvelope,
              configFiles: [],
              silent: false,
              gateFailing: true,
            },
            orgId,
          ),
        ).toMatchObject({ staged: true });
        expect(
          await finalizeStagedReviewCompletionWithGateMode(
            db,
            {
              reviewId,
              reviewJobLease,
              expectedReviewInput: job.rows[0]!.payload,
              staleCleanup,
              usageAccountingComplete: true,
              terminalStatus: "failed",
              errorMessage: "Review execution did not produce a reviewer verdict.",
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
            },
            orgId,
          ),
        ).toMatchObject({
          completed: true,
          gateEnabled,
          gateFailing: gateEnabled,
        });

        const persisted = await pool.query<{
          status: string;
          error_message: string | null;
          has_envelope: boolean;
          usage: number;
          gate_failing: boolean;
        }>(
          `SELECT status, error_message, envelope IS NOT NULL AS has_envelope,
                  gate_failing,
                  (SELECT count(*)::int FROM usage_events WHERE review_id = reviews.id) AS usage
             FROM reviews WHERE id = $1`,
          [reviewId],
        );
        expect(persisted.rows[0]).toEqual({
          status: "failed",
          error_message: "Review execution did not produce a reviewer verdict.",
          has_envelope: true,
          usage: 1,
          gate_failing: gateEnabled,
        });

        const row = (await getOrgReviewRows(db, orgId, 20)).find(
          (entry) => entry.id === reviewId,
        );
        expect(row).toMatchObject({ status: "failed", gateFailing: gateEnabled });
        const reviewMarkup = renderToStaticMarkup(
          createElement(ReviewStatusBadge, {
            status: row!.status,
            gateFailing: row!.gateFailing,
          }),
        );
        const gateMarkup = renderToStaticMarkup(
          createElement(GateBadge, {
            status: row!.status,
            gateFailing: row!.gateFailing,
          }),
        );
        expect(reviewMarkup).toContain("failed");
        expect(reviewMarkup).not.toContain("/status/pass.svg");
        if (gateEnabled) {
          expect(gateMarkup).toContain("failing");
          expect(gateMarkup).toContain("/status/error.svg");
        } else {
          expect(gateMarkup).toContain("neutral");
          expect(gateMarkup).toContain("/status/info.svg");
        }
        expect(gateMarkup).not.toContain("passing");
      }
    } finally {
      await pool.query(
        "UPDATE org_settings SET gate_enabled = true WHERE org_id = $1",
        [orgId],
      );
    }
  });

  test("persists exact initial channels and reconciles later carried and resolved states", async () => {
    const firstId = await createRunningReview("b".repeat(40));
    firstPublicationReviewId = firstId;
    await complete(
      firstId,
      envelope({
        head: "b".repeat(40),
        findings: [finding("inline-id"), finding("summary-id")],
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
        ],
      },
    );

    const secondId = await createRunningReview("c".repeat(40), "b".repeat(40));
    secondPublicationReviewId = secondId;
    await complete(
      secondId,
      envelope({
        head: "c".repeat(40),
        since: "b".repeat(40),
        findings: [finding("inline-id", "[carried from previous review]\n\nA complete finding body.")],
        resolved: [finding("summary-id")],
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
      { finding_id: "summary-id", initial_state: "summaryOnly", current_state: "resolved" },
    ]);

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

    await expect(
      pool.query(
        "UPDATE finding_publications SET initial_state = 'unknown' WHERE review_id = $1 AND finding_id = 'inline-id'",
        [firstId],
      ),
    ).rejects.toThrow("immutable");
  });

  test("reconciles same-finding comment reuse and rejects cross-finding reuse", async () => {
    const firstReviewId = await createRunningReview("91".repeat(20), null, false);
    const secondReviewId = await createRunningReview("92".repeat(20), null, false);
    for (const reviewId of [firstReviewId, secondReviewId]) {
      await pool.query(
        `INSERT INTO finding_publications
          (review_id, finding_id, stable_identity, initial_state, current_state, github_comment_id)
         VALUES ($1, 'reused-comment-finding', true, 'inline', 'inline', '8701')`,
        [reviewId],
      );
    }

    await applyPublicationThreadObservations(db, [
      {
        githubCommentId: "8701",
        state: "resolved",
        resolutionAuthorized: true,
      },
    ]);
    expect(
      (
        await pool.query<{ review_id: string; current_state: string }>(
          `SELECT review_id, current_state
             FROM finding_publications
            WHERE github_comment_id = '8701'
            ORDER BY review_id`,
        )
      ).rows,
    ).toEqual([
      { review_id: String(firstReviewId), current_state: "resolved" },
      { review_id: String(secondReviewId), current_state: "resolved" },
    ]);
    const dashboardRows = await getOrgReviewRows(db, orgId, 20);
    expect(dashboardRows.find((row) => row.id === firstReviewId)).toMatchObject({
      findingsCount: 0,
    });
    expect(dashboardRows.find((row) => row.id === secondReviewId)).toMatchObject({
      findingsCount: 0,
    });

    await expect(
      applyPublicationThreadObservations(db, [
        { githubCommentId: "8701", state: "outdated" },
        { githubCommentId: "8701", state: "deleted" },
      ]),
    ).rejects.toThrow("conflicting GitHub publication thread observations");

    const conflictingReviewId = await createRunningReview(
      "93".repeat(20),
      null,
      false,
    );
    await expect(
      pool.query(
        `INSERT INTO finding_publications
          (review_id, finding_id, stable_identity, initial_state, current_state, github_comment_id)
         VALUES ($1, 'different-finding', true, 'inline', 'inline', '8701')`,
        [conflictingReviewId],
      ),
    ).rejects.toThrow(
      "GitHub publication comment identity already belongs to another finding",
    );
  });

  test("records worker-observed resolver provenance in the lifecycle transition transaction", async () => {
    const reviewId = await createRunningReview("96".repeat(20), null, false);
    await pool.query(
      `INSERT INTO finding_publications
        (review_id, finding_id, stable_identity, initial_state, current_state, github_comment_id)
       VALUES
         ($1, 'worker-reconciled-finding', true, 'inline', 'inline', '8799'),
         ($1, 'unstable-worker-finding', false, 'inline', 'inline', '8798')`,
      [reviewId],
    );

    const observedCommentIds = await getPullRequestPublicationCommentIds(db, repositoryId, 7);
    expect(observedCommentIds).toContain("8799");
    expect(observedCommentIds).not.toContain("8798");

    await reconcilePublicationThreadObservations(db, `review:${reviewId}`, [
      {
        githubCommentId: "8799",
        state: "resolved",
        resolutionAuthorized: true,
        resolvedByGithubId: 502,
        resolvedByLogin: "maintainer",
      },
    ]);

    expect((await pool.query<{
      current_state: string;
      resolver_github_id: string;
      resolver_login: string;
      resolution_authorized: boolean;
      source_delivery_id: string;
    }>(
      `SELECT publication.current_state,
              observation.resolver_github_id,
              observation.resolver_login,
              observation.resolution_authorized,
              observation.source_delivery_id
         FROM finding_publications publication
         INNER JOIN finding_lifecycle_observations observation
           ON observation.review_id = publication.review_id
          AND observation.finding_id = publication.finding_id
        WHERE publication.review_id = $1`,
      [reviewId],
    )).rows).toEqual([{
      current_state: "resolved",
      resolver_github_id: "502",
      resolver_login: "maintainer",
      resolution_authorized: true,
      source_delivery_id: `review:${reviewId}`,
    }]);

    await expect(
      reconcilePublicationThreadObservations(db, "review:missing-binding", [
        {
          githubCommentId: "999999",
          state: "resolved",
          resolutionAuthorized: true,
          resolvedByGithubId: 502,
          resolvedByLogin: "maintainer",
        },
      ]),
    ).rejects.toThrow("no durable finding binding");
  });

  test("serializes concurrent cross-finding GitHub comment claims", async () => {
    const firstReviewId = await createRunningReview("94".repeat(20), null, false);
    const secondReviewId = await createRunningReview("95".repeat(20), null, false);
    const claims = await Promise.allSettled([
      pool.query(
        `INSERT INTO finding_publications
          (review_id, finding_id, stable_identity, initial_state, current_state, github_comment_id)
         VALUES ($1, 'concurrent-first', true, 'inline', 'inline', '8702')`,
        [firstReviewId],
      ),
      pool.query(
        `INSERT INTO finding_publications
          (review_id, finding_id, stable_identity, initial_state, current_state, github_comment_id)
         VALUES ($1, 'concurrent-second', true, 'inline', 'inline', '8702')`,
        [secondReviewId],
      ),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM finding_publications WHERE github_comment_id = '8702'",
        )
      ).rows[0]?.count,
    ).toBe("1");
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
    const firstId = firstPublicationReviewId;
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
      { githubCommentId: "8001", state: "resolved", resolutionAuthorized: true },
    ]);
    await applyPublicationThreadObservations(db, [
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

  test("does not accept a resolution without current maintainer authority", async () => {
    const reviewId = await createRunningReview("e".repeat(40));
    await complete(
      reviewId,
      envelope({ head: "e".repeat(40), findings: [finding("untrusted-resolution")] }),
      {
        version: 1,
        receiptId: "forge-review-v1:untrusted-resolution",
        findings: [{
          findingId: "untrusted-resolution",
          stableIdentity: true,
          initialOutcome: "inline",
          inlineRejected: false,
          commentId: "8999",
        }],
      },
    );
    await applyPublicationThreadObservations(db, [
      { githubCommentId: "8999", state: "resolved", resolutionAuthorized: false },
    ]);
    expect(
      (
        await pool.query<{ current_state: string }>(
          "SELECT current_state FROM finding_publications WHERE review_id = $1 AND finding_id = 'untrusted-resolution'",
          [reviewId],
        )
      ).rows[0]?.current_state,
    ).toBe("inline");
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
    expect(dashboardRows.find((row) => row.id === secondPublicationReviewId)).toMatchObject({
      findingsCount: 1,
    });
  });

  test("dashboard rows use the author-dismissal acknowledgement ledger", async () => {
    const headSha = "8".repeat(40);
    const policyFinding = {
      ...finding("author-dismissal"),
      severity: "error" as const,
    };
    const reviewEnvelope: Envelope = {
      ...envelope({ head: headSha, findings: [policyFinding] }),
      counts: { info: 0, warn: 0, error: 1, suppressed: 0, ungrounded: 0 },
      gate: { failOn: "error", failing: true },
    };
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, source_org_id, source_installation_id,
         source_github_installation_id, source_github_repo_id, source_repo_full_name,
         pr_number, head_sha, base_sha, status, trigger_source, queued_at, started_at)
       SELECT repository.id, installation.org_id, installation.id,
              installation.github_installation_id, repository.github_repo_id, repository.full_name,
              7, $1, $2, 'running', 'unknown', now(), now()
         FROM repositories repository
         JOIN installations installation ON installation.id = repository.installation_id
        WHERE repository.id = $3
       RETURNING id`,
      [headSha, "a".repeat(40), repositoryId],
    );
    const reviewId = Number(review.rows[0]!.id);
    reviewIds.push(reviewId);
    await complete(reviewId, reviewEnvelope);
    const author = await pool.query<{ id: string }>(
      "INSERT INTO users (github_id, login) VALUES (2001, 'author-admin') RETURNING id",
    );
    const reviewer = await pool.query<{ id: string }>(
      "INSERT INTO users (github_id, login) VALUES (2002, 'reviewer-admin') RETURNING id",
    );
    const binding = {
      orgId,
      repositoryId,
      githubInstallationId: 1002,
      githubRepoId: 1003,
      prNumber: 7,
      headSha,
    };
    await insertFindingApproval(db, {
      reviewId,
      findingId: policyFinding.id!,
      actor: {
        userId: Number(author.rows[0]!.id),
        githubId: "2001",
        login: "author-admin",
        role: "admin",
      },
      rationale: "Accepted by the pull request author.",
      verb: "dismiss",
      reasonTag: "accepted-risk",
      authorSelfDismissal: true,
      finding: policyFinding,
      findingModel: reviewEnvelope.modelUsed,
      source: "dashboard",
      binding,
    });

    expect(
      (await getOrgReviewRows(db, orgId, 20)).find((row) => row.id === reviewId),
    ).toMatchObject({ gateFailing: true });

    await revokeFindingApproval(
      db,
      reviewId,
      policyFinding.id!,
      Number(reviewer.rows[0]!.id),
      "dismiss",
    );
    await insertFindingApproval(db, {
      reviewId,
      findingId: policyFinding.id!,
      actor: {
        userId: Number(reviewer.rows[0]!.id),
        githubId: "2002",
        login: "reviewer-admin",
        role: "admin",
      },
      rationale: "Independently acknowledged.",
      source: "dashboard",
      binding,
    });

    expect(
      (await getOrgReviewRows(db, orgId, 20)).find((row) => row.id === reviewId),
    ).toMatchObject({ gateFailing: false });
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
