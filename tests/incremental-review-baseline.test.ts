import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";
import * as schema from "@/lib/db/schema";
import { incrementalBaselineUsable } from "@/lib/github/checks";
import { loadIncrementalReviewBaseline } from "@/worker/review";

const describeDb = process.env.POSTIL_TEST_DATABASE_URL ? describe : describe.skip;

const ORIGINAL_FETCH = globalThis.fetch;

describe("incremental baseline ancestry", () => {
  test("accepts a baseline the compare still descends from", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({ merge_base_commit: { sha: "a".repeat(40) } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      expect(
        await incrementalBaselineUsable(
          "token",
          "acme/service",
          "a".repeat(40),
          "b".repeat(40),
        ),
      ).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(
        `/repos/acme/service/compare/${"a".repeat(40)}...${"b".repeat(40)}?per_page=1`,
      );
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  test("rejects a baseline the compare no longer descends from", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({ merge_base_commit: { sha: "c".repeat(40) } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    try {
      expect(
        await incrementalBaselineUsable(
          "token",
          "acme/service",
          "a".repeat(40),
          "b".repeat(40),
        ),
      ).toBe(false);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  test("propagates a compare failure for the caller to decide", async () => {
    globalThis.fetch = Object.assign(
      async () => new Response("gone", { status: 404 }),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    try {
      await expect(
        incrementalBaselineUsable(
          "token",
          "acme/service",
          "a".repeat(40),
          "b".repeat(40),
        ),
      ).rejects.toThrow("HTTP 404");
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });
});

describeDb("incremental review baseline selection", () => {
  let db: EphemeralDatabase;
  let pool: Pool;
  let repositoryId: number;

  const cleanEnvelope = {
    findings: [
      { path: "src/lib/auth.ts", line: 4, title: "Real finding" },
    ],
  };
  const sentinelEnvelope = {
    findings: [
      {
        path: ".postil/model-output",
        line: 1,
        title: "Review incomplete",
      },
    ],
  };

  beforeAll(async () => {
    db = await createEphemeralDatabase("incremental_baseline");
    pool = db.pool;
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, suspended)
       VALUES (910001, 'baseline-test', 'Organization', false) RETURNING id`,
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, enabled)
       VALUES ($1, 910001001, 'baseline-test/service', true) RETURNING id`,
      [installation.rows[0]!.id],
    );
    repositoryId = Number(repository.rows[0]!.id);
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  async function insertReview(input: {
    prNumber: number;
    headSha: string;
    status: string;
    envelope: unknown;
    finishedMinutesAgo: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, trigger_source,
          envelope, queued_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, 'unknown', $6,
               now() - make_interval(mins => $7), now() - make_interval(mins => $7))`,
      [
        repositoryId,
        input.prNumber,
        input.headSha,
        "0".repeat(40),
        input.status,
        JSON.stringify(input.envelope),
        input.finishedMinutesAgo,
      ],
    );
  }

  test("skips a completed review whose envelope carries an operational sentinel", async () => {
    await insertReview({
      prNumber: 41,
      headSha: "1".repeat(40),
      status: "completed",
      envelope: cleanEnvelope,
      finishedMinutesAgo: 60,
    });
    await insertReview({
      prNumber: 41,
      headSha: "2".repeat(40),
      status: "completed",
      envelope: sentinelEnvelope,
      finishedMinutesAgo: 10,
    });

    const baseline = await loadIncrementalReviewBaseline(
      drizzle(pool, { schema }),
      repositoryId,
      41,
    );
    expect(baseline?.headSha).toBe("1".repeat(40));
  });

  test("returns the newest verdict-bearing review and ignores failed rows", async () => {
    await insertReview({
      prNumber: 42,
      headSha: "3".repeat(40),
      status: "completed",
      envelope: cleanEnvelope,
      finishedMinutesAgo: 60,
    });
    await insertReview({
      prNumber: 42,
      headSha: "4".repeat(40),
      status: "completed",
      envelope: cleanEnvelope,
      finishedMinutesAgo: 20,
    });
    await insertReview({
      prNumber: 42,
      headSha: "5".repeat(40),
      status: "failed",
      envelope: cleanEnvelope,
      finishedMinutesAgo: 5,
    });

    const baseline = await loadIncrementalReviewBaseline(
      drizzle(pool, { schema }),
      repositoryId,
      42,
    );
    expect(baseline?.headSha).toBe("4".repeat(40));
  });

  test("finds no baseline when every completed review lacks a verdict", async () => {
    await insertReview({
      prNumber: 43,
      headSha: "6".repeat(40),
      status: "completed",
      envelope: sentinelEnvelope,
      finishedMinutesAgo: 30,
    });

    const baseline = await loadIncrementalReviewBaseline(
      drizzle(pool, { schema }),
      repositoryId,
      43,
    );
    expect(baseline).toBeUndefined();
  });
});
