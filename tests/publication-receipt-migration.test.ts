import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/lib/db/schema";
import type { Envelope, Finding } from "@/lib/envelope";
import { getOrgReviewRows } from "@/lib/org-reviews";
import {
  applyPublicationThreadObservations,
  getReviewPublicationCounts,
  type PublicationReceipt,
} from "@/lib/publication-receipt";
import {
  finalizeStagedReviewCompletionWithGateMode,
  persistReviewCompletionWithGateMode,
  stageReviewCompletionCandidate,
} from "@/lib/review-completion";

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

describeDb("publication receipt migration and lifecycle", () => {
  const pool = new Pool({ connectionString: TEST_URL, max: 2 });
  const db = drizzle(pool, { schema });
  let orgId = 0;
  let repositoryId = 0;
  const reviewIds: number[] = [];

  async function createRunningReview(headSha: string, sinceSha: string | null = null) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, since_sha, status, trigger_source, queued_at, started_at)
       VALUES ($1, 7, $2, $3, $4, 'running', 'unknown', now(), now())
       RETURNING id`,
      [repositoryId, headSha, "a".repeat(40), sinceSha],
    );
    const id = Number(result.rows[0]!.id);
    reviewIds.push(id);
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
      recovery_gate_conclusion: string;
      receipts: string;
      usage: string;
    }>(
      `SELECT review.status,
              review.envelope IS NOT NULL AS has_envelope,
              job.payload->>'recoveryReviewId' AS recovery_review_id,
              job.payload->>'recoveryGateConclusion' AS recovery_gate_conclusion,
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
      recovery_gate_conclusion: "success",
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
  });

  test("persists exact initial channels and reconciles later carried and resolved states", async () => {
    const firstId = await createRunningReview("b".repeat(40));
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

  test("does not persist operational receipt entries as finding lifecycle rows", async () => {
    const reviewId = await createRunningReview("d".repeat(40));
    const publishedFinding = finding("published-id");
    const operationalFinding = {
      ...finding("operational-id"),
      path: ".postil/provider",
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
  });

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
});
