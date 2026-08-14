import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";

import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

const INPUT_ONE = "1".repeat(64);
const INPUT_TWO = "2".repeat(64);
const PAYLOAD_ONE = "3".repeat(64);
const PAYLOAD_TWO = "4".repeat(64);

function operationKey(value: number) {
  return value.toString(16).padStart(64, "0");
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
  }) {
    await pool.query(
      `INSERT INTO review_publication_generations
        (repository_id, pr_number, publication_generation, review_id, accepted_input_digest, head_sha)
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
      "superseded",
      "compensating",
      "failed",
    ];
    for (const [index, state] of states.entries()) {
      await pool.query(
        `INSERT INTO review_publication_operations
          (repository_id, pr_number, publication_generation, review_id, operation_key, kind,
           desired_payload, desired_payload_digest, state, attempt_count, retry_after, deadline_at,
           last_error, remote_identity, remote_operation_id, remote_observed_at, applied_at)
         VALUES ($1, $2, 1, $3, $4, 'check', $5, $6, $7, $8,
                 now() + interval '1 minute', now() + interval '1 hour', $9, $10, $11,
                 now(), CASE WHEN $7 = 'applied' THEN now() ELSE NULL END)`,
        [
          repositoryId,
          prNumber,
          firstReviewId,
          operationKey(index + 1),
          JSON.stringify({ operation: index + 1 }),
          PAYLOAD_ONE,
          state,
          index,
          state === "failed" ? "bounded failure" : null,
          `remote:${index + 1}`,
          `operation:${index + 1}`,
        ],
      );
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
        (repository_id, pr_number, publication_generation, review_id, operation_key, kind,
         desired_payload, desired_payload_digest)
       VALUES ($1, $2, 2, $3, $4, 'check', $5, $6)`,
      [
        repositoryId,
        prNumber,
        secondReviewId,
        operationKey(20),
        JSON.stringify({ operation: 20 }),
        PAYLOAD_TWO,
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
    expect(operations.rows).toHaveLength(8);
    expect(operations.rows.filter((entry) => entry.publication_generation === "1")).toHaveLength(7);
    expect(new Set(operations.rows.map((entry) => entry.state))).toEqual(new Set(states));
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
    await insertGeneration({
      prNumber,
      generation: 2,
      reviewId: secondReviewId,
      inputDigest: INPUT_TWO,
      headSha: secondHead,
    });
    await insertHighWater({
      prNumber,
      generation: 1,
      reviewId: firstReviewId,
      inputDigest: INPUT_ONE,
      headSha: firstHead,
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
    ).rejects.toThrow("generation creation time is immutable");
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
    await pool.query(
      `INSERT INTO review_publication_operations
        (repository_id, pr_number, publication_generation, review_id, operation_key, kind,
         desired_payload, desired_payload_digest)
       VALUES ($1, $2, 1, $3, $4, 'review', $5, $6)`,
      [
        repositoryId,
        prNumber,
        reviewId,
        operationKey(30),
        JSON.stringify({ review: true }),
        PAYLOAD_ONE,
      ],
    );

    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET state = 'applying'
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("operation updates must advance updated_at");
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'applying',
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
        WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, prNumber, operationKey(30)],
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET desired_payload = '{"review":false}'::jsonb
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("operation intent is immutable");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
            SET created_at = created_at + interval '1 second'
          WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operationKey(30)],
      ),
    ).rejects.toThrow("operation creation time is immutable");
    await expect(
      pool.query(
        `INSERT INTO review_publication_operations
          (repository_id, pr_number, publication_generation, review_id, operation_key, kind,
           desired_payload, desired_payload_digest, state, attempt_count)
         VALUES ($1, $2, 1, $3, 'invalid', 'review', '{}', $4, 'pending', 0)`,
        [repositoryId, prNumber, reviewId, PAYLOAD_ONE],
      ),
    ).rejects.toThrow("review_publication_operations_key_check");
    await expect(
      pool.query(
        `INSERT INTO review_publication_operations
          (repository_id, pr_number, publication_generation, review_id, operation_key, kind,
           desired_payload, desired_payload_digest, state, attempt_count)
         VALUES ($1, $2, 1, $3, $4, 'review', '{}', $5, 'invalid-state', 0)`,
        [repositoryId, prNumber, reviewId, operationKey(31), PAYLOAD_ONE],
      ),
    ).rejects.toThrow("review_publication_operations_state_check");
    await expect(
      pool.query(
        `INSERT INTO review_publication_operations
          (repository_id, pr_number, publication_generation, review_id, operation_key, kind,
           desired_payload, desired_payload_digest, attempt_count)
         VALUES ($1, $2, 1, $3, $4, 'review', '{}', $5, -1)`,
        [repositoryId, prNumber, reviewId, operationKey(32), PAYLOAD_ONE],
      ),
    ).rejects.toThrow("review_publication_operations_attempt_count_check");
  });
});
