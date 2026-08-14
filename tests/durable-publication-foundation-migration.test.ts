import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Pool } from "pg";

import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

const INPUT_ONE = "1".repeat(64);
const INPUT_TWO = "2".repeat(64);
const ENVELOPE_DIGEST = "3".repeat(64);
const SIGNED_PLAN_OPERATION_KEYS = [
  `github-publication-v1:composite-review:sha256:${"a".repeat(64)}`,
  `github-publication-v1:file-comment-fallback:sha256:${"b".repeat(64)}`,
  `github-publication-v1:advisory-check:sha256:${"c".repeat(64)}`,
  `github-publication-v1:gate-check:sha256:${"d".repeat(64)}`,
] as const;

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function payloadDigest(value: Record<string, unknown>) {
  return sha256(JSON.stringify(value));
}

function operationKey(value: number) {
  return `github-publication-v1:composite-review:sha256:${value
    .toString(16)
    .padStart(64, "0")}`;
}

describeDb("durable publication foundation migration", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  let repositoryId = 0;

  async function createReview(prNumber: number, headSha: string) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source, queued_at)
       VALUES ($1, $2, $3, $4, 'queued', 'unknown', now())
       RETURNING id`,
      [repositoryId, prNumber, headSha, "a".repeat(40)],
    );
    return Number(result.rows[0]!.id);
  }

  async function insertGeneration(input: {
    prNumber: number;
    generation: number;
    reviewId: number;
    inputDigest: string;
    headSha: string;
    baseSha?: string;
    planVersion?: string;
    acceptedPlanText?: string;
    acceptedPlanBytes?: Buffer;
    acceptedPlanDigest?: string;
    planSemanticDigest?: string;
    reviewInputSequence?: number;
    expectedPullRequestUpdatedAt?: string;
    envelopeDigest?: string;
    repositoryFullName?: string;
    targetSha?: string;
    targetBranch?: string;
    pullRequestTitle?: string;
    pullRequestBody?: string;
    createdAt?: string;
  }) {
    const baseSha = input.baseSha ?? "a".repeat(40);
    const acceptedPlanText = input.acceptedPlanText ?? JSON.stringify({
      version: input.planVersion ?? "github-publication-v1",
      reviewId: input.reviewId,
      reviewInputSequence: String(input.reviewInputSequence ?? input.generation),
      expectedPullRequestUpdatedAt:
        input.expectedPullRequestUpdatedAt ?? "2026-08-14T00:00:00.000Z",
      inputDigest: input.inputDigest,
      envelopeDigest: input.envelopeDigest ?? ENVELOPE_DIGEST,
      planSemanticDigest: input.planSemanticDigest ?? "4".repeat(64),
      repository: input.repositoryFullName ?? "publication-foundation/repository",
      pullRequest: {
        number: input.prNumber,
        headSha: input.headSha,
        baseSha,
        targetSha: input.targetSha ?? baseSha,
        targetBranch: input.targetBranch ?? "main",
        title: input.pullRequestTitle ?? "Publication foundation",
        body: input.pullRequestBody ?? "",
      },
    });
    const acceptedPlanBytes = input.acceptedPlanBytes ?? Buffer.from(acceptedPlanText);
    await pool.query(
      `INSERT INTO review_publication_generations
        (repository_id, pr_number, publication_generation, review_id, plan_version,
         accepted_plan, accepted_plan_bytes, accepted_plan_digest, plan_semantic_digest,
         review_input_sequence,
         expected_pull_request_updated_at, accepted_input_digest, envelope_digest,
         repository_full_name, head_sha, base_sha, target_sha, target_branch, pull_request_title,
         pull_request_body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        repositoryId,
        input.prNumber,
        input.generation,
        input.reviewId,
        input.planVersion ?? "github-publication-v1",
        acceptedPlanText,
        acceptedPlanBytes,
        input.acceptedPlanDigest ?? sha256(acceptedPlanBytes),
        input.planSemanticDigest ?? "4".repeat(64),
        input.reviewInputSequence ?? input.generation,
        input.expectedPullRequestUpdatedAt ?? "2026-08-14T00:00:00.000Z",
        input.inputDigest,
        input.envelopeDigest ?? ENVELOPE_DIGEST,
        input.repositoryFullName ?? "publication-foundation/repository",
        input.headSha,
        baseSha,
        input.targetSha ?? baseSha,
        input.targetBranch ?? "main",
        input.pullRequestTitle ?? "Publication foundation",
        input.pullRequestBody ?? "",
        input.createdAt ?? "2026-08-14T00:00:00.000Z",
      ],
    );
  }

  async function insertHighWater(input: {
    prNumber: number;
    generation: number;
    reviewId: number;
    inputDigest: string;
    headSha: string;
  }) {
    await pool.query(
      `INSERT INTO pull_request_publication_high_waters
        (repository_id, pr_number, publication_generation, accepted_review_id, accepted_input_digest, accepted_head_sha)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        repositoryId,
        input.prNumber,
        input.generation,
        input.reviewId,
        input.inputDigest,
        input.headSha,
      ],
    );
  }

  async function createPopulatedPublication(seed: number) {
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, github_org_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`publication-teardown-${seed}`, `Publication teardown ${seed}`, 7000 + seed],
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
        (github_installation_id, account_login, account_type, org_id)
       VALUES ($1, $2, 'Organization', $3) RETURNING id`,
      [8000 + seed, `publication-teardown-${seed}`, organization.rows[0]!.id],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
        (github_repo_id, installation_id, full_name, private, enabled)
       VALUES ($1, $2, $3, false, true) RETURNING id`,
      [9000 + seed, installation.rows[0]!.id, `publication-teardown-${seed}/repository`],
    );
    const fixtureRepositoryId = Number(repository.rows[0]!.id);
    const prNumber = 800 + seed;
    const headSha = seed.toString(16).padStart(40, "a").slice(-40);
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source, queued_at)
       VALUES ($1, $2, $3, $4, 'queued', 'unknown', now()) RETURNING id`,
      [fixtureRepositoryId, prNumber, headSha, "b".repeat(40)],
    );
    const reviewId = Number(review.rows[0]!.id);
    const planText = JSON.stringify({ version: "github-publication-v1", seed });
    await pool.query(
      `INSERT INTO review_publication_generations
        (repository_id, pr_number, publication_generation, review_id, plan_version,
         accepted_plan, accepted_plan_bytes, accepted_plan_digest, plan_semantic_digest,
         review_input_sequence,
         expected_pull_request_updated_at, accepted_input_digest, envelope_digest,
         repository_full_name, head_sha, base_sha, target_sha, target_branch, pull_request_title,
         pull_request_body)
       VALUES ($1, $2, 1, $3, 'github-publication-v1', $4::jsonb, $5, $6,
               $7, 1, '2026-08-14T00:00:00Z', $8, $9, $10, $11, $12, $12, 'main', $13, '')`,
      [
        fixtureRepositoryId,
        prNumber,
        reviewId,
        planText,
        Buffer.from(planText),
        sha256(planText),
        "4".repeat(64),
        INPUT_ONE,
        ENVELOPE_DIGEST,
        `publication-teardown-${seed}/repository`,
        headSha,
        "b".repeat(40),
        `Publication teardown ${seed}`,
      ],
    );
    await pool.query(
      `INSERT INTO pull_request_publication_high_waters
        (repository_id, pr_number, publication_generation, accepted_review_id, accepted_input_digest, accepted_head_sha)
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [fixtureRepositoryId, prNumber, reviewId, INPUT_ONE, headSha],
    );
    const primaryOperationKey = operationKey(100 + seed);
    await pool.query(
      `INSERT INTO review_publication_operations
        (repository_id, pr_number, publication_generation, review_id, operation_key,
         operation_ordinal, activation_condition, kind, desired_payload,
         desired_payload_bytes, desired_payload_digest)
       VALUES ($1, $2, 1, $3, $4, 0, 'immediate', 'review', '{}', '{}'::text::bytea, $5)`,
      [fixtureRepositoryId, prNumber, reviewId, primaryOperationKey, payloadDigest({})],
    );
    await pool.query(
      `INSERT INTO review_publication_operations
        (repository_id, pr_number, publication_generation, review_id, operation_key,
         operation_ordinal, dependency_operation_key, activation_condition, kind,
         desired_payload, desired_payload_bytes, desired_payload_digest)
       VALUES ($1, $2, 1, $3, $4, 1, $5, 'after_dependency_terminal', 'check',
               '{}', '{}'::text::bytea, $6)`,
      [
        fixtureRepositoryId,
        prNumber,
        reviewId,
        operationKey(200 + seed),
        primaryOperationKey,
        payloadDigest({}),
      ],
    );
    return {
      installationId: Number(installation.rows[0]!.id),
      repositoryId: fixtureRepositoryId,
      reviewId,
    };
  }

  async function expectPublicationRows(
    repositoryIdentity: number,
    expected: number,
    expectedOperations = expected,
  ) {
    for (const table of [
      "review_publication_generations",
      "pull_request_publication_high_waters",
      "review_publication_operations",
    ]) {
      const result = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE repository_id = $1`,
        [repositoryIdentity],
      );
      expect(result.rows[0]!.count).toBe(
        table === "review_publication_operations" ? expectedOperations : expected,
      );
    }
  }

  async function insertRawOperation(input: {
    prNumber: number;
    reviewId: number;
    key: string;
    generation?: number;
    ordinal?: number;
    dependencyKey?: string | null;
    activationCondition?: string;
    kind?: string;
    payload?: string;
    payloadBytes?: Buffer;
    digest?: string;
    state?: string;
    attempts?: number;
    claimOwner?: string | null;
    leaseId?: string | null;
    leaseExpiresAt?: string | null;
    leaseGeneration?: number;
    retryAfter?: string | null;
    deadlineAt?: string | null;
    lastError?: string | null;
    remoteIdentity?: string | null;
    remoteOperationId?: string | null;
    remoteObservedAt?: string | null;
    appliedAt?: string | null;
    resultPayload?: string | null;
    selectedVariant?: string | null;
    reconciliationPayload?: string | null;
    compensatedAt?: string | null;
    compensationPayload?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }) {
    const payload = input.payload ?? "{}";
    await pool.query(
      `INSERT INTO review_publication_operations
        (repository_id, pr_number, publication_generation, review_id, operation_key,
         operation_ordinal, dependency_operation_key, activation_condition, kind,
         desired_payload, desired_payload_bytes, desired_payload_digest, state, attempt_count,
         claim_owner, lease_id, lease_expires_at, lease_generation, retry_after, deadline_at,
         last_error, remote_identity, remote_operation_id, remote_observed_at, applied_at,
         result_payload, selected_variant, reconciliation_payload, compensated_at,
         compensation_payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
               $27, $28, $29, $30, $31, $32)`,
      [
        repositoryId,
        input.prNumber,
        input.generation ?? 1,
        input.reviewId,
        input.key,
        input.ordinal ?? 0,
        input.dependencyKey ?? null,
        input.activationCondition ?? "immediate",
        input.kind ?? "review",
        payload,
        input.payloadBytes ?? Buffer.from(payload),
        input.digest ?? sha256(input.payloadBytes ?? Buffer.from(payload)),
        input.state ?? "pending",
        input.attempts ?? 0,
        input.claimOwner ?? null,
        input.leaseId ?? null,
        input.leaseExpiresAt ?? null,
        input.leaseGeneration ?? 0,
        input.retryAfter ?? null,
        input.deadlineAt ?? null,
        input.lastError ?? null,
        input.remoteIdentity ?? null,
        input.remoteOperationId ?? null,
        input.remoteObservedAt ?? null,
        input.appliedAt ?? null,
        input.resultPayload ?? null,
        input.selectedVariant ?? null,
        input.reconciliationPayload ?? null,
        input.compensatedAt ?? null,
        input.compensationPayload ?? null,
        input.createdAt ?? "2026-08-14T00:00:00.000Z",
        input.updatedAt ?? "2026-08-14T00:00:00.000Z",
      ],
    );
  }

  beforeAll(async () => {
    database = await createEphemeralDatabase("durable_publication_foundation");
    pool = database.pool;
    const organization = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('publication-foundation', 'Publication foundation', 6101) RETURNING id",
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
        (github_installation_id, account_login, account_type, org_id)
       VALUES (6102, 'publication-foundation', 'Organization', $1)
       RETURNING id`,
      [organization.rows[0]!.id],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
        (github_repo_id, installation_id, full_name, private, enabled)
       VALUES (6103, $1, 'publication-foundation/repository', false, true)
       RETURNING id`,
      [installation.rows[0]!.id],
    );
    repositoryId = Number(repository.rows[0]!.id);
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  test("preserves generations and supports multiple operation kinds and recovery states", async () => {
    const prNumber = 700;
    const firstHead = "b".repeat(40);
    const secondHead = "c".repeat(40);
    const firstReviewId = await createReview(prNumber, firstHead);
    const secondReviewId = await createReview(prNumber, secondHead);

    await insertGeneration({
      prNumber,
      generation: 1,
      reviewId: firstReviewId,
      inputDigest: INPUT_ONE,
      headSha: firstHead,
    });
    await insertHighWater({
      prNumber,
      generation: 1,
      reviewId: firstReviewId,
      inputDigest: INPUT_ONE,
      headSha: firstHead,
    });

    const states = [
      "pending",
      "applying",
      "unknown",
      "applied",
      "skipped",
      "superseded",
      "compensating",
      "failed",
    ];
    for (const [index, state] of states.entries()) {
      const active = state === "applying" || state === "compensating";
      const ambiguous = state === "unknown";
      const applied = state === "applied";
      await insertRawOperation({
        prNumber,
        reviewId: firstReviewId,
        key: operationKey(index + 1),
        ordinal: index,
        kind: "check",
        payload: JSON.stringify({ operation: index + 1 }),
        state,
        attempts: index,
        claimOwner: active ? "worker-one" : null,
        leaseId: active ? "00000000-0000-4000-8000-000000000001" : null,
        leaseExpiresAt: active ? "2026-08-14T00:05:00.000Z" : null,
        leaseGeneration: active || ambiguous ? 1 : 0,
        retryAfter: "2026-08-14T00:01:00.000Z",
        deadlineAt: "2026-08-14T01:00:00.000Z",
        lastError:
          state === "failed"
            ? "bounded failure"
            : ambiguous
              ? "remote outcome is ambiguous"
              : null,
        remoteIdentity: applied ? `remote:${index + 1}` : null,
        remoteOperationId: applied ? `operation:${index + 1}` : null,
        remoteObservedAt: applied ? "2026-08-14T00:00:01.000Z" : null,
        appliedAt: applied ? "2026-08-14T00:00:01.000Z" : null,
        resultPayload:
          applied || state === "skipped"
            ? JSON.stringify({ outcome: state })
            : null,
        selectedVariant: active || ambiguous || applied ? "primary" : null,
      });
    }

    await insertGeneration({
      prNumber,
      generation: 2,
      reviewId: secondReviewId,
      inputDigest: INPUT_TWO,
      headSha: secondHead,
    });
    await pool.query(
      `UPDATE pull_request_publication_high_waters
          SET publication_generation = 2,
              accepted_review_id = $3,
              accepted_input_digest = $4,
              accepted_head_sha = $5,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, prNumber, secondReviewId, INPUT_TWO, secondHead],
    );
    await pool.query(
      `INSERT INTO review_publication_operations
        (repository_id, pr_number, publication_generation, review_id, operation_key,
         operation_ordinal, activation_condition, kind, desired_payload,
         desired_payload_bytes, desired_payload_digest)
       VALUES ($1, $2, 2, $3, $4, 0, 'immediate', 'check', $5::jsonb, $6, $7)`,
      [
        repositoryId,
        prNumber,
        secondReviewId,
        operationKey(20),
        JSON.stringify({ operation: 20 }),
        Buffer.from(JSON.stringify({ operation: 20 })),
        payloadDigest({ operation: 20 }),
      ],
    );

    const highWater = await pool.query<{
      publication_generation: string;
      accepted_review_id: string;
      accepted_input_digest: string;
      accepted_head_sha: string;
    }>(
      `SELECT publication_generation, accepted_review_id, accepted_input_digest, accepted_head_sha
         FROM pull_request_publication_high_waters
        WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, prNumber],
    );
    expect(highWater.rows).toEqual([
      {
        publication_generation: "2",
        accepted_review_id: String(secondReviewId),
        accepted_input_digest: INPUT_TWO,
        accepted_head_sha: secondHead,
      },
    ]);

    const operations = await pool.query<{
      publication_generation: string;
      state: string;
    }>(
      `SELECT publication_generation, state
         FROM review_publication_operations
        WHERE repository_id = $1 AND pr_number = $2
        ORDER BY publication_generation, operation_key`,
      [repositoryId, prNumber],
    );
    expect(operations.rows).toHaveLength(9);
    expect(operations.rows.filter((entry) => entry.publication_generation === "1")).toHaveLength(8);
    expect(new Set(operations.rows.map((entry) => entry.state))).toEqual(new Set(states));
  });

  test("accepts the signed plan operation key contract and rejects raw digests", async () => {
    const prNumber = 709;
    const headSha = "1".repeat(40);
    const reviewId = await createReview(prNumber, headSha);
    await insertGeneration({
      prNumber,
      generation: 1,
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
    });
    for (const [ordinal, key] of SIGNED_PLAN_OPERATION_KEYS.entries()) {
      await insertRawOperation({ prNumber, reviewId, key, ordinal });
    }
    expect(
      new Set(
        (
          await pool.query<{ operation_key: string }>(
            `SELECT operation_key FROM review_publication_operations
              WHERE repository_id = $1 AND pr_number = $2`,
            [repositoryId, prNumber],
          )
        ).rows.map((row) => row.operation_key),
      ),
    ).toEqual(new Set(SIGNED_PLAN_OPERATION_KEYS));
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: "b".repeat(64),
      }),
    ).rejects.toThrow("review_publication_operations_key_check");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: `github-publication-v1:postil/review:sha256:${"e".repeat(64)}`,
      }),
    ).rejects.toThrow("review_publication_operations_key_check");
  });

  test("binds exact accepted plan bytes separately from CLI semantic identity", async () => {
    const prNumber = 710;
    const headSha = "0".repeat(40);
    const targetSha = "f".repeat(40);
    const reviewId = await createReview(prNumber, headSha);
    const planText = '{"version":"github-publication-v1", "operations":[]}';
    const semanticDigest = "5".repeat(64);
    await insertGeneration({
      prNumber,
      generation: 1,
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
      targetSha,
      acceptedPlanText: planText,
      planSemanticDigest: semanticDigest,
    });
    const stored = await pool.query<{
      accepted_plan_digest: string;
      plan_semantic_digest: string;
      plan_text: string;
      target_sha: string;
    }>(
      `SELECT accepted_plan_digest, plan_semantic_digest,
              convert_from(accepted_plan_bytes, 'UTF8') AS plan_text, target_sha
         FROM review_publication_generations
        WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, prNumber],
    );
    expect(stored.rows[0]).toEqual({
      accepted_plan_digest: sha256(planText),
      plan_semantic_digest: semanticDigest,
      plan_text: planText,
      target_sha: targetSha,
    });
    expect(stored.rows[0]!.accepted_plan_digest).not.toBe(semanticDigest);

    for (const [column, value] of [
      ["accepted_plan_bytes", Buffer.from('{"version":"github-publication-v2"}')],
      ["plan_semantic_digest", "6".repeat(64)],
      ["target_sha", "e".repeat(40)],
    ] as const) {
      await expect(
        pool.query(
          `UPDATE review_publication_generations SET ${column} = $3
            WHERE repository_id = $1 AND pr_number = $2`,
          [repositoryId, prNumber, value],
        ),
      ).rejects.toThrow("review publication generation is immutable");
    }
    await expect(
      insertGeneration({
        prNumber,
        generation: 2,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
        acceptedPlanText: planText,
        acceptedPlanDigest: "0".repeat(64),
      }),
    ).rejects.toThrow("review_publication_generations_plan_check");
    await expect(
      insertGeneration({
        prNumber,
        generation: 2,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
        acceptedPlanText: planText,
        acceptedPlanBytes: Buffer.from('{"version":"different"}'),
      }),
    ).rejects.toThrow("review_publication_generations_plan_check");
    await expect(
      insertGeneration({
        prNumber,
        generation: 2,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
        planSemanticDigest: "invalid",
      }),
    ).rejects.toThrow("review_publication_generations_plan_semantic_digest_check");
    await expect(
      insertGeneration({
        prNumber,
        generation: 2,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
        targetSha: "invalid",
      }),
    ).rejects.toThrow("review_publication_generations_target_sha_check");
    await expect(
      insertGeneration({
        prNumber,
        generation: 2,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
        reviewInputSequence: 0,
      }),
    ).rejects.toThrow("review_publication_generations_review_input_sequence_check");
  });

  test("rejects malformed identities and generations that do not match their reviews", async () => {
    const prNumber = 701;
    const headSha = "d".repeat(40);
    const reviewId = await createReview(prNumber, headSha);

    await expect(
      insertGeneration({
        prNumber,
        generation: 1,
        reviewId,
        inputDigest: "not-a-digest",
        headSha,
      }),
    ).rejects.toThrow("review_publication_generations_input_digest_check");
    await expect(
      insertGeneration({
        prNumber: prNumber + 1,
        generation: 1,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
      }),
    ).rejects.toThrow("does not match its review identity");
    await expect(
      insertGeneration({
        prNumber,
        generation: 0,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
      }),
    ).rejects.toThrow("review_publication_generations_generation_check");
  });

  test("rejects every malformed publication identity and recovery bound", async () => {
    const prNumber = 704;
    const headSha = "8".repeat(40);
    const reviewId = await createReview(prNumber, headSha);
    await insertGeneration({
      prNumber,
      generation: 1,
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
    });

    const zeroPrReviewId = await createReview(0, headSha);
    await expect(
      insertGeneration({
        prNumber: 0,
        generation: 1,
        reviewId: zeroPrReviewId,
        inputDigest: INPUT_ONE,
        headSha,
      }),
    ).rejects.toThrow("review_publication_generations_pr_number_check");
    const malformedHeadReviewId = await createReview(prNumber + 1, "invalid");
    await expect(
      insertGeneration({
        prNumber: prNumber + 1,
        generation: 1,
        reviewId: malformedHeadReviewId,
        inputDigest: INPUT_ONE,
        headSha: "invalid",
      }),
    ).rejects.toThrow("review_publication_generations_head_sha_check");

    const invalidHighWaters: Array<[number, number, string, string, string]> = [
      [0, 1, INPUT_ONE, headSha, "pull_request_publication_high_waters_pr_number_check"],
      [prNumber, 0, INPUT_ONE, headSha, "pull_request_publication_high_waters_generation_check"],
      [prNumber, 1, "invalid", headSha, "pull_request_publication_high_waters_input_digest_check"],
    ];
    for (const [invalidPr, generation, digest, head, constraint] of invalidHighWaters) {
      await expect(
        pool.query(
          `INSERT INTO pull_request_publication_high_waters
            (repository_id, pr_number, publication_generation, accepted_review_id,
             accepted_input_digest, accepted_head_sha)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [repositoryId, invalidPr, generation, reviewId, digest, head],
        ),
      ).rejects.toThrow(constraint);
    }

    const validOperation = {
      prNumber,
      generation: 1,
      key: operationKey(40),
      kind: "review",
      payload: JSON.stringify({ review: true }),
      digest: payloadDigest({ review: true }),
      state: "pending",
      attempts: 0,
      deadline: null as string | null,
      error: null as string | null,
      remoteIdentity: null as string | null,
      remoteOperationId: null as string | null,
    };
    const invalidOperations: Array<[
      Partial<typeof validOperation>,
      string,
    ]> = [
      [{ prNumber: 0 }, "review_publication_operations_pr_number_check"],
      [{ generation: 0 }, "review_publication_operations_generation_check"],
      [{ kind: "Invalid kind" }, "review_publication_operations_kind_check"],
      [{ payload: "[]" }, "review_publication_operations_payload_check"],
      [{ digest: "invalid" }, "review_publication_operations_payload_digest_check"],
      [{ deadline: "2000-01-01T00:00:00.000Z" }, "review_publication_operations_deadline_check"],
      [{ error: "" }, "review_publication_operations_error_check"],
      [{ error: "x".repeat(4001) }, "review_publication_operations_error_check"],
      [{ remoteIdentity: "" }, "review_publication_operations_remote_identity_check"],
      [{ remoteIdentity: "x".repeat(501) }, "review_publication_operations_remote_identity_check"],
      [{ remoteOperationId: "" }, "review_publication_operations_remote_operation_id_check"],
      [{ remoteOperationId: "x".repeat(501) }, "review_publication_operations_remote_operation_id_check"],
    ];
    for (const [caseIndex, [override, constraint]] of invalidOperations.entries()) {
      const operation = {
        ...validOperation,
        ...override,
        key: operationKey(41 + caseIndex),
      };
      await expect(
        insertRawOperation({
          prNumber: operation.prNumber,
          generation: operation.generation,
          reviewId,
          key: operation.key,
          kind: operation.kind,
          payload: operation.payload,
          digest: operation.digest,
          state: operation.state,
          attempts: operation.attempts,
          deadlineAt: operation.deadline,
          lastError: operation.error,
          remoteIdentity: operation.remoteIdentity,
          remoteOperationId: operation.remoteOperationId,
        }),
      ).rejects.toThrow(constraint);
    }
  });

  test("rejects high-water regression and identity changes without an advance", async () => {
    const prNumber = 702;
    const firstHead = "e".repeat(40);
    const secondHead = "f".repeat(40);
    const firstReviewId = await createReview(prNumber, firstHead);
    const secondReviewId = await createReview(prNumber, secondHead);
    await insertGeneration({
      prNumber,
      generation: 1,
      reviewId: firstReviewId,
      inputDigest: INPUT_ONE,
      headSha: firstHead,
    });
    await insertHighWater({
      prNumber,
      generation: 1,
      reviewId: firstReviewId,
      inputDigest: INPUT_ONE,
      headSha: firstHead,
    });
    await insertGeneration({
      prNumber,
      generation: 2,
      reviewId: secondReviewId,
      inputDigest: INPUT_TWO,
      headSha: secondHead,
    });

    await expect(
      pool.query(
        `UPDATE pull_request_publication_high_waters
            SET pr_number = $3
          WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, prNumber, prNumber + 100],
      ),
    ).rejects.toThrow("high-water identity is immutable");
    await expect(
      pool.query(
        `UPDATE pull_request_publication_high_waters
            SET repository_id = $3
          WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, prNumber, repositoryId + 1],
      ),
    ).rejects.toThrow("high-water identity is immutable");
    await expect(
      pool.query(
        `UPDATE pull_request_publication_high_waters
            SET created_at = created_at + interval '1 second'
          WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, prNumber],
      ),
    ).rejects.toThrow("high-water creation time is immutable");
    await expect(
      pool.query(
        `UPDATE pull_request_publication_high_waters
            SET accepted_input_digest = $3
          WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, prNumber, INPUT_TWO],
      ),
    ).rejects.toThrow("identity requires a higher generation");
    await expect(
      pool.query(
        `UPDATE pull_request_publication_high_waters
            SET publication_generation = 0
          WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, prNumber],
      ),
    ).rejects.toThrow("generation cannot decrease");
    await expect(
      pool.query(
        `UPDATE pull_request_publication_high_waters
            SET publication_generation = 2,
                accepted_review_id = $3,
                accepted_input_digest = $4,
                accepted_head_sha = $5
          WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, prNumber, secondReviewId, INPUT_TWO, secondHead],
      ),
    ).rejects.toThrow("updates must advance updated_at");
    await pool.query(
      `UPDATE pull_request_publication_high_waters
          SET publication_generation = 2,
              accepted_review_id = $3,
              accepted_input_digest = $4,
              accepted_head_sha = $5,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, prNumber, secondReviewId, INPUT_TWO, secondHead],
    );
    await expect(
      pool.query(
        `INSERT INTO pull_request_publication_high_waters
          (repository_id, pr_number, publication_generation, accepted_review_id, accepted_input_digest, accepted_head_sha)
         VALUES ($1, $2, 2, $3, $4, $5)`,
        [repositoryId, prNumber, secondReviewId, INPUT_TWO, "not-a-sha"],
      ),
    ).rejects.toThrow("pull_request_publication_high_waters_head_sha_check");
    await expect(
      pool.query(
        `UPDATE review_publication_generations
            SET created_at = created_at + interval '1 second'
          WHERE repository_id = $1 AND pr_number = $2 AND publication_generation = 1`,
        [repositoryId, prNumber],
      ),
    ).rejects.toThrow("review publication generation is immutable");
    await expect(
      pool.query(
        `UPDATE review_publication_generations
            SET accepted_input_digest = $3
          WHERE repository_id = $1 AND pr_number = $2 AND publication_generation = 1`,
        [repositoryId, prNumber, INPUT_TWO],
      ),
    ).rejects.toThrow("review publication generation is immutable");
  });

  test("enforces ordered operation dependencies and exact payload-byte digests", async () => {
    const prNumber = 711;
    const headSha = "7".repeat(40);
    const reviewId = await createReview(prNumber, headSha);
    await insertGeneration({
      prNumber,
      generation: 1,
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
    });
    const exactPayload = '{\n  "check":"postil/review"\n}';
    await insertRawOperation({
      prNumber,
      reviewId,
      key: operationKey(200),
      ordinal: 0,
      payload: exactPayload,
    });
    await insertRawOperation({
      prNumber,
      reviewId,
      key: operationKey(201),
      ordinal: 1,
      dependencyKey: operationKey(200),
      activationCondition: "after_dependency_applied",
    });
    const payloadIdentity = await pool.query<{
      desired_payload_digest: string;
      exact_payload: string;
      jsonb_payload: string;
    }>(
      `SELECT desired_payload_digest,
              convert_from(desired_payload_bytes, 'UTF8') AS exact_payload,
              desired_payload::text AS jsonb_payload
         FROM review_publication_operations
        WHERE repository_id = $1 AND pr_number = $2 AND operation_ordinal = 0`,
      [repositoryId, prNumber],
    );
    expect(payloadIdentity.rows[0]).toEqual({
      desired_payload_digest: sha256(exactPayload),
      exact_payload: exactPayload,
      jsonb_payload: '{"check": "postil/review"}',
    });
    expect(payloadIdentity.rows[0]!.exact_payload).not.toBe(
      payloadIdentity.rows[0]!.jsonb_payload,
    );

    await insertRawOperation({
      prNumber,
      reviewId,
      key: operationKey(204),
      ordinal: 4,
    });
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(203),
        ordinal: 3,
        dependencyKey: operationKey(204),
        activationCondition: "after_dependency_applied",
      }),
    ).rejects.toThrow("dependency must be an earlier operation in the same generation");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(205),
        ordinal: 2,
        dependencyKey: operationKey(200),
        activationCondition: "immediate",
      }),
    ).rejects.toThrow("review_publication_operations_activation_check");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(206),
        ordinal: 2,
        activationCondition: "after_dependency_terminal",
      }),
    ).rejects.toThrow("review_publication_operations_activation_check");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(207),
        ordinal: 1,
      }),
    ).rejects.toThrow("review_publication_operations_ordinal_idx");
    for (const [column, value] of [
      ["operation_ordinal", 9],
      ["dependency_operation_key", operationKey(204)],
      ["activation_condition", "after_dependency_terminal"],
      ["desired_payload_bytes", Buffer.from('{"check":"postil/gate"}')],
    ] as const) {
      await expect(
        pool.query(
          `UPDATE review_publication_operations SET ${column} = $4
            WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
          [repositoryId, prNumber, operationKey(201), value],
        ),
      ).rejects.toThrow("operation intent is immutable");
    }
  });

  test("requires non-empty immutable terminal and reconciliation evidence", async () => {
    const prNumber = 712;
    const headSha = "6".repeat(40);
    const reviewId = await createReview(prNumber, headSha);
    await insertGeneration({
      prNumber,
      generation: 1,
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
    });
    await insertRawOperation({
      prNumber,
      reviewId,
      key: operationKey(210),
      ordinal: 0,
    });
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'skipped', result_payload = '{}'::jsonb,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(210)],
      ),
    ).rejects.toThrow("review_publication_operations_evidence_payloads_check");
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'skipped', result_payload = '{"reason":"dependency-not-selected"}'::jsonb,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(210)],
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET result_payload = NULL,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(210)],
      ),
    ).rejects.toThrow("result evidence is immutable");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'pending',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(210)],
      ),
    ).rejects.toThrow("invalid review publication operation state transition");

    await insertRawOperation({
      prNumber,
      reviewId,
      key: operationKey(211),
      ordinal: 1,
    });
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'applying', attempt_count = 1, selected_variant = 'primary',
              claim_owner = 'worker-one',
              lease_id = '00000000-0000-4000-8000-000000000011',
              lease_expires_at = clock_timestamp() + interval '5 minutes',
              lease_generation = 1,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(211)],
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'unknown', selected_variant = NULL,
                claim_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
                last_error = 'remote outcome unavailable',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(211)],
      ),
    ).rejects.toThrow("result evidence is immutable");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'unknown', claim_owner = NULL, lease_id = NULL,
                lease_expires_at = NULL,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(211)],
      ),
    ).rejects.toThrow("review_publication_operations_state_evidence_check");
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'unknown', claim_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error = 'remote outcome unavailable',
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(211)],
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'failed', last_error = 'remote outcome unavailable',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(211)],
      ),
    ).rejects.toThrow("reconciliation requires an observation payload");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'failed', last_error = 'remote outcome unavailable',
                reconciliation_payload = '{}'::jsonb,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(211)],
      ),
    ).rejects.toThrow("review_publication_operations_evidence_payloads_check");
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'failed', last_error = 'remote outcome unavailable',
              reconciliation_payload = '{"remoteState":"unknown"}'::jsonb,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(211)],
    );
    for (const payload of [null, '{"remoteState":"absent"}']) {
      await expect(
        pool.query(
          `UPDATE review_publication_operations SET reconciliation_payload = $4,
                  updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
            WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
          [repositoryId, prNumber, operationKey(211), payload],
        ),
      ).rejects.toThrow("reconciliation evidence is immutable");
    }
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(212),
        ordinal: 2,
        state: "applied",
        remoteIdentity: "review-summary",
        remoteOperationId: "9012",
        remoteObservedAt: "2026-08-14T00:00:01.000Z",
        appliedAt: "2026-08-14T00:00:01.000Z",
        resultPayload: "{}",
        selectedVariant: "primary",
      }),
    ).rejects.toThrow("review_publication_operations_evidence_payloads_check");
  });

  test("rejects mutable operation intent and invalid operation recovery values", async () => {
    const prNumber = 703;
    const headSha = "9".repeat(40);
    const reviewId = await createReview(prNumber, headSha);
    await insertGeneration({
      prNumber,
      generation: 1,
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
    });
    await insertHighWater({
      prNumber,
      generation: 1,
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
    });
    await insertRawOperation({
      prNumber,
      reviewId,
      key: operationKey(30),
      payload: JSON.stringify({ review: true }),
    });

    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'applying', claim_owner = 'worker-one',
                lease_id = '00000000-0000-4000-8000-000000000001',
                lease_expires_at = clock_timestamp() + interval '5 minutes',
                lease_generation = 1, selected_variant = 'primary',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("claims must advance attempt count");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'applying', claim_owner = 'worker-one',
                lease_id = '00000000-0000-4000-8000-000000000001',
                lease_expires_at = clock_timestamp() + interval '5 minutes',
                lease_generation = 1, attempt_count = 1, selected_variant = 'primary'
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("operation updates must advance updated_at");
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'applying',
              claim_owner = 'worker-one',
              lease_id = '00000000-0000-4000-8000-000000000001',
              lease_expires_at = clock_timestamp() + interval '5 minutes',
              lease_generation = 1, attempt_count = 1, selected_variant = 'primary',
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(30)],
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET selected_variant = 'fallback',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("result evidence is immutable");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET desired_payload = '{"review":false}'::jsonb
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("operation intent is immutable");
    for (const [column, value] of [
      ["operation_key", operationKey(99)],
      ["kind", "check"],
      ["desired_payload_digest", payloadDigest({ review: false })],
    ]) {
      await expect(
        pool.query(
          `UPDATE review_publication_operations SET ${column} = $4
            WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
          [repositoryId, prNumber, operationKey(30), value],
        ),
      ).rejects.toThrow("operation intent is immutable");
    }
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET created_at = created_at + interval '1 second'
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("operation intent is immutable");
    await expect(
      insertRawOperation({ prNumber, reviewId, key: "invalid" }),
    ).rejects.toThrow("review_publication_operations_key_check");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(31),
        state: "invalid-state",
      }),
    ).rejects.toThrow("review_publication_operations_state_check");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(32),
        attempts: -1,
      }),
    ).rejects.toThrow("review_publication_operations_attempt_count_check");

    await pool.query(
      `UPDATE review_publication_operations
          SET attempt_count = 2,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(30)],
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET attempt_count = 1,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("attempts cannot decrease");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET lease_generation = 0,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("lease generation cannot decrease");
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'applied', claim_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
              remote_identity = 'review-summary', remote_operation_id = '9001',
              remote_observed_at = clock_timestamp(), applied_at = clock_timestamp(),
              result_payload = '{"remoteIds":["9001"]}'::jsonb,
              selected_variant = 'primary',
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(30)],
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET selected_variant = 'fallback',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("result evidence is immutable");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'compensating', claim_owner = 'worker-two',
                lease_id = '00000000-0000-4000-8000-000000000002',
                lease_expires_at = clock_timestamp() + interval '5 minutes',
                lease_generation = 2,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("claims must advance attempt count");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'pending', remote_identity = NULL, remote_operation_id = NULL,
                remote_observed_at = NULL, applied_at = NULL,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("invalid review publication operation state transition");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'compensating', claim_owner = 'worker-two',
                lease_id = '00000000-0000-4000-8000-000000000002',
                lease_expires_at = clock_timestamp() + interval '5 minutes',
                lease_generation = 2, attempt_count = 3,
                remote_identity = NULL, remote_operation_id = NULL,
                remote_observed_at = NULL, applied_at = NULL,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("result evidence is immutable");
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'compensating', claim_owner = 'worker-two',
              lease_id = '00000000-0000-4000-8000-000000000002',
              lease_expires_at = clock_timestamp() + interval '5 minutes',
              lease_generation = 2, attempt_count = 3,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(30)],
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET claim_owner = 'stale-worker',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("lease identity requires a higher generation");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET remote_identity = 'replacement-summary',
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("result evidence is immutable");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET result_payload = NULL,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("result evidence is immutable");
    const staleUpdate = await pool.query(
      `UPDATE review_publication_operations
          SET state = 'unknown', claim_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3
          AND lease_generation = 1
          AND lease_id = '00000000-0000-4000-8000-000000000001'`,
      [repositoryId, prNumber, operationKey(30)],
    );
    expect(staleUpdate.rowCount).toBe(0);
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET lease_generation = 1,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("lease generation cannot decrease");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'superseded', claim_owner = NULL, lease_id = NULL,
                lease_expires_at = NULL,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("compensation requires observation evidence");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'superseded', claim_owner = NULL, lease_id = NULL,
                lease_expires_at = NULL, compensated_at = clock_timestamp(),
                compensation_payload = '{}'::jsonb,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("review_publication_operations_evidence_payloads_check");
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'superseded', claim_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
              compensated_at = clock_timestamp(),
              compensation_payload = '{"remoteAbsent":true}'::jsonb,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(30)],
    );
    const completion = await pool.query<{
      applied_at: Date | null;
      remote_identity: string | null;
      remote_operation_id: string | null;
      compensated_at: Date | null;
      compensation_payload: { remoteAbsent: boolean } | null;
      state: string;
    }>(
      `SELECT state, applied_at, remote_identity, remote_operation_id,
              compensated_at, compensation_payload
         FROM review_publication_operations
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(30)],
    );
    expect(completion.rows[0]).toMatchObject({
      state: "superseded",
      applied_at: expect.any(Date),
      remote_identity: "review-summary",
      remote_operation_id: "9001",
      compensated_at: expect.any(Date),
      compensation_payload: { remoteAbsent: true },
    });
    for (const assignment of [
      "compensated_at = compensated_at + interval '1 second'",
      "compensation_payload = '{\"remoteAbsent\":false}'::jsonb",
      "compensation_payload = NULL",
    ]) {
      await expect(
        pool.query(
          `UPDATE review_publication_operations SET ${assignment},
                  updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
            WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
          [repositoryId, prNumber, operationKey(30)],
        ),
      ).rejects.toThrow("compensation evidence is immutable");
    }
  });

  test("rejects shadowed review identity lookup through pg_temp", async () => {
    const client = await pool.connect();
    try {
      const prNumber = 705;
      const publicHead = "7".repeat(40);
      const reviewId = await createReview(prNumber, publicHead);
      await client.query("BEGIN");
      await client.query(
        "CREATE TEMP TABLE reviews (id bigint, repository_id bigint, pr_number integer, head_sha text, base_sha text)",
      );
      await client.query(
        "INSERT INTO reviews VALUES ($1, $2, $3, $4, $5)",
        [reviewId, repositoryId, prNumber + 1, "6".repeat(40), "a".repeat(40)],
      );
      await client.query("SET LOCAL search_path = pg_temp, public");
      await expect(
        client.query(
          `INSERT INTO public.review_publication_generations
            (repository_id, pr_number, publication_generation, review_id, plan_version,
             accepted_plan, accepted_plan_bytes, accepted_plan_digest, plan_semantic_digest,
             review_input_sequence, expected_pull_request_updated_at, accepted_input_digest,
             envelope_digest, repository_full_name, head_sha, base_sha, target_sha,
             target_branch, pull_request_title, pull_request_body)
           VALUES ($1, $2, 1, $3, 'github-publication-v1', $4::jsonb, $5,
                   $6, $7, 1, '2026-08-14T00:00:00Z', $8, $9,
                   'publication-foundation/repository', $10, $11, $11, 'main', 'Title', '')`,
          [
            repositoryId,
            prNumber + 1,
            reviewId,
            '{"version":"github-publication-v1"}',
            Buffer.from('{"version":"github-publication-v1"}'),
            sha256('{"version":"github-publication-v1"}'),
            "4".repeat(64),
            INPUT_ONE,
            ENVELOPE_DIGEST,
            "6".repeat(40),
            "a".repeat(40),
          ],
        ),
      ).rejects.toThrow("does not match its review identity");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  test("rejects generation reset and direct publication child deletion", async () => {
    const fixture = await createPopulatedPublication(4);
    await expect(
      pool.query("DELETE FROM review_publication_operations WHERE repository_id = $1", [fixture.repositoryId]),
    ).rejects.toThrow("operations can only be deleted by parent teardown");
    await expect(
      pool.query("DELETE FROM pull_request_publication_high_waters WHERE repository_id = $1", [fixture.repositoryId]),
    ).rejects.toThrow("high-water rows can only be deleted by parent teardown");
    await expect(
      pool.query("DELETE FROM review_publication_generations WHERE repository_id = $1", [fixture.repositoryId]),
    ).rejects.toThrow("generations can only be deleted by parent teardown");
    await expectPublicationRows(fixture.repositoryId, 1, 2);

    const prNumber = 706;
    const firstHead = "5".repeat(40);
    const secondHead = "4".repeat(40);
    const firstReviewId = await createReview(prNumber, firstHead);
    const secondReviewId = await createReview(prNumber, secondHead);
    await insertGeneration({ prNumber, generation: 1, reviewId: firstReviewId, inputDigest: INPUT_ONE, headSha: firstHead });
    await insertGeneration({ prNumber, generation: 2, reviewId: secondReviewId, inputDigest: INPUT_TWO, headSha: secondHead });
    await expect(
      insertHighWater({ prNumber, generation: 1, reviewId: firstReviewId, inputDigest: INPUT_ONE, headSha: firstHead }),
    ).rejects.toThrow("must use the latest retained generation");
    await insertHighWater({ prNumber, generation: 2, reviewId: secondReviewId, inputDigest: INPUT_TWO, headSha: secondHead });
    await expect(
      insertGeneration({ prNumber, generation: 2, reviewId: secondReviewId, inputDigest: INPUT_TWO, headSha: secondHead }),
    ).rejects.toThrow("review_publication_generations_pr_generation_idx");

    await pool.query("DELETE FROM repositories WHERE id = $1", [fixture.repositoryId]);
    await expectPublicationRows(fixture.repositoryId, 0);
  });

  test("rejects composite identity mismatches", async () => {
    const prNumber = 707;
    const headSha = "3".repeat(40);
    const reviewId = await createReview(prNumber, headSha);
    await insertGeneration({ prNumber, generation: 1, reviewId, inputDigest: INPUT_ONE, headSha });

    await expect(
      pool.query(
        `INSERT INTO pull_request_publication_high_waters
          (repository_id, pr_number, publication_generation, accepted_review_id,
           accepted_input_digest, accepted_head_sha)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [repositoryId, prNumber, reviewId, INPUT_TWO, headSha],
      ),
    ).rejects.toThrow("pull_request_publication_high_waters_generation_fk");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        generation: 2,
        key: operationKey(80),
      }),
    ).rejects.toThrow("review_publication_operations_generation_fk");
  });

  test("rejects non-finite timestamps and incomplete recovery evidence", async () => {
    const prNumber = 708;
    const headSha = "2".repeat(40);
    const reviewId = await createReview(prNumber, headSha);
    await insertGeneration({ prNumber, generation: 1, reviewId, inputDigest: INPUT_ONE, headSha });

    await expect(
      insertGeneration({
        prNumber,
        generation: 2,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
        createdAt: "infinity",
      }),
    ).rejects.toThrow("review_publication_generations_created_at_check");
    await expect(
      insertGeneration({
        prNumber,
        generation: 2,
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
        expectedPullRequestUpdatedAt: "infinity",
      }),
    ).rejects.toThrow("review_publication_generations_created_at_check");
    for (const timestampColumn of ["created_at", "updated_at"]) {
      await expect(
        pool.query(
          `INSERT INTO pull_request_publication_high_waters
            (repository_id, pr_number, publication_generation, accepted_review_id,
             accepted_input_digest, accepted_head_sha, ${timestampColumn})
           VALUES ($1, $2, 1, $3, $4, $5, 'infinity')`,
          [repositoryId, prNumber, reviewId, INPUT_ONE, headSha],
        ),
      ).rejects.toThrow("pull_request_publication_high_waters_timestamps_check");
    }

    const timestampCases: Array<Partial<Parameters<typeof insertRawOperation>[0]>> = [
      { createdAt: "infinity" },
      { updatedAt: "infinity" },
      { retryAfter: "infinity" },
      { deadlineAt: "infinity" },
      {
        state: "applying",
        attempts: 1,
        claimOwner: "worker-one",
        leaseId: "00000000-0000-4000-8000-000000000002",
        leaseExpiresAt: "infinity",
        leaseGeneration: 1,
        selectedVariant: "primary",
      },
      {
        state: "applied",
        remoteIdentity: "review-summary",
        remoteOperationId: "9002",
        remoteObservedAt: "2026-08-14T00:00:00.000Z",
        appliedAt: "infinity",
        resultPayload: '{"remoteId":"9002"}',
        selectedVariant: "primary",
      },
      {
        state: "applied",
        remoteIdentity: "review-summary",
        remoteOperationId: "9003",
        remoteObservedAt: "infinity",
        appliedAt: "2026-08-14T00:00:00.000Z",
        resultPayload: '{"remoteId":"9003"}',
        selectedVariant: "primary",
      },
      {
        state: "superseded",
        compensatedAt: "infinity",
        compensationPayload: '{"remoteAbsent":true}',
      },
    ];
    for (const [caseIndex, invalid] of timestampCases.entries()) {
      await expect(
        insertRawOperation({
          prNumber,
          reviewId,
          key: operationKey(81 + caseIndex),
          ...invalid,
        }),
      ).rejects.toThrow("review_publication_operations_timestamps_check");
    }

    await expect(
      insertRawOperation({ prNumber, reviewId, key: operationKey(90), attempts: 1_000_001 }),
    ).rejects.toThrow("review_publication_operations_attempt_count_check");
    await expect(
      insertRawOperation({ prNumber, reviewId, key: operationKey(91), state: "applying" }),
    ).rejects.toThrow("review_publication_operations_lease_check");
    await expect(
      insertRawOperation({ prNumber, reviewId, key: operationKey(92), state: "applied" }),
    ).rejects.toThrow("review_publication_operations_state_evidence_check");
    await expect(
      insertRawOperation({ prNumber, reviewId, key: operationKey(93), state: "failed" }),
    ).rejects.toThrow("review_publication_operations_state_evidence_check");
    await expect(
      insertRawOperation({ prNumber, reviewId, key: operationKey(94), claimOwner: "" }),
    ).rejects.toThrow("review_publication_operations_claim_owner_check");
    await expect(
      insertRawOperation({ prNumber, reviewId, key: operationKey(95), claimOwner: "x".repeat(201) }),
    ).rejects.toThrow("review_publication_operations_claim_owner_check");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(96),
        digest: "0".repeat(64),
      }),
    ).rejects.toThrow("review_publication_operations_payload_digest_check");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(97),
        state: "applying",
        claimOwner: "worker-one",
        leaseId: "00000000-0000-4000-8000-000000000003",
        leaseExpiresAt: "2026-08-13T00:00:00.000Z",
        leaseGeneration: 1,
      }),
    ).rejects.toThrow("review_publication_operations_lease_check");
    for (const [caseIndex, state] of ["applying", "compensating"].entries()) {
      await expect(
        insertRawOperation({
          prNumber,
          reviewId,
          key: operationKey(98 + caseIndex),
          state,
          attempts: 1,
          claimOwner: "worker-one",
          leaseId: `00000000-0000-4000-8000-${String(10 + caseIndex).padStart(12, "0")}`,
          leaseExpiresAt: "2026-08-14T00:05:00.000Z",
          leaseGeneration: 1,
        }),
      ).rejects.toThrow("review_publication_operations_state_evidence_check");
    }
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(100),
        state: "unknown",
        attempts: 1,
        leaseGeneration: 1,
        lastError: "remote outcome unavailable",
      }),
    ).rejects.toThrow("review_publication_operations_state_evidence_check");
    await expect(
      insertRawOperation({
        prNumber,
        reviewId,
        key: operationKey(101),
        state: "unknown",
        attempts: 1,
        leaseGeneration: 1,
        selectedVariant: "primary",
      }),
    ).rejects.toThrow("review_publication_operations_state_evidence_check");
  });

  test("cascades publication audit rows when a review is explicitly deleted", async () => {
    const fixture = await createPopulatedPublication(1);
    await expectPublicationRows(fixture.repositoryId, 1, 2);

    await pool.query("DELETE FROM reviews WHERE id = $1", [fixture.reviewId]);

    await expectPublicationRows(fixture.repositoryId, 0);
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM repositories WHERE id = $1",
          [fixture.repositoryId],
        )
      ).rows[0]!.count,
    ).toBe(1);
  });

  test("cascades publication audit rows when a repository is explicitly deleted", async () => {
    const fixture = await createPopulatedPublication(2);
    await expectPublicationRows(fixture.repositoryId, 1, 2);

    await pool.query("DELETE FROM repositories WHERE id = $1", [fixture.repositoryId]);

    await expectPublicationRows(fixture.repositoryId, 0);
  });

  test("cascades publication audit rows when an installation is explicitly deleted", async () => {
    const fixture = await createPopulatedPublication(3);
    await expectPublicationRows(fixture.repositoryId, 1, 2);

    await pool.query("DELETE FROM installations WHERE id = $1", [fixture.installationId]);

    await expectPublicationRows(fixture.repositoryId, 0);
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM repositories WHERE id = $1",
          [fixture.repositoryId],
        )
      ).rows[0]!.count,
    ).toBe(0);
  });
});
