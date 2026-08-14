import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

import * as schema from "@/lib/db/schema";
import { reconcileConservativeHostedReviewSpend } from "@/lib/hosted-usage-reservations";
import {
  PostgresLargeReviewAttemptStore,
  claimReusableLargeReviewReservation,
  largeReviewAttemptKey,
  largeReviewRunKey,
  type LargeReviewRunIdentity,
} from "@/lib/large-review-resume";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("large-review durable resume migration", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  let databaseUrl: string;
  let orgId = 0;
  let repositoryId = 0;
  let reviewId = 0;

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("large_review", {
      forceDrop: true,
      maxConnections: 2,
    });
    databaseUrl = database.url;
    const migration = new Client({ connectionString: databaseUrl });
    await migration.connect();
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d{4}_.*[.]sql$/.test(file))
      .sort();
    for (const file of files) {
      const source = await readFile(join(migrationDirectory, file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migration.query(statement);
      }
    }
    const organization = await migration.query<{ id: string }>(
      "INSERT INTO organizations (slug, name) VALUES ('large-review', 'Large Review') RETURNING id",
    );
    orgId = Number(organization.rows[0]!.id);
    const installation = await migration.query<{ id: string }>(
      `INSERT INTO installations
        (github_installation_id, account_login, account_type, org_id)
       VALUES (771001, 'large-review', 'Organization', $1)
       RETURNING id`,
      [organization.rows[0]!.id],
    );
    const repository = await migration.query<{ id: string }>(
      `INSERT INTO repositories
        (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, 771002, 'large-review/repo', true, true)
       RETURNING id`,
      [installation.rows[0]!.id],
    );
    repositoryId = Number(repository.rows[0]!.id);
    const review = await migration.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source)
       VALUES ($1, 1, $2, $3, 'running', 'unknown')
       RETURNING id`,
      [repositoryId, "b".repeat(40), "0".repeat(40)],
    );
    reviewId = Number(review.rows[0]!.id);
    await migration.end();
    pool = database.pool;
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  });

  test("claims, completes, replays, and deletes one exact durable run", async () => {
    const store = new PostgresLargeReviewAttemptStore(drizzle(pool, { schema }));
    const identity: LargeReviewRunIdentity = {
      repositoryId,
      prNumber: 1,
      cliVersion: "0.8.0",
      configurationSha256: "a".repeat(64),
      providerIdentity: '["managed","openai-compatible","https://example.test/v1"]',
      headSha: "b".repeat(40),
      baseSha: "0".repeat(40),
      retryLineage: "review-job:1",
      planSha256: "c".repeat(64),
    };
    const context = { currentReviewId: reviewId, hostedReservationId: null };
    const runKey = await store.bindRun(identity, context);
    expect(await store.bindRun(identity, context)).toBe(runKey);
    const attempt = {
      runKey,
      requestSha256: "d".repeat(64),
      batchIdentity: "e".repeat(64),
      attempt: 1,
      model: "openai/test-model",
    };
    const claim = await store.claimAttempt(attempt);
    expect(claim.kind).toBe("execute");
    if (claim.kind !== "execute") throw new Error("attempt was not claimed");
    const response = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"choices":[{"message":{"content":"complete"}}]}',
    };
    await store.completeAttempt({
      attemptKey: claim.attemptKey,
      leaseId: claim.leaseId,
      response,
    });
    expect(await store.claimAttempt({ ...attempt, attempt: 2 })).toEqual({
      kind: "replay",
      response,
    });

    await store.deleteRun(runKey);
    const counts = await pool.query<{ runs: string; attempts: string }>(
      `SELECT
         (SELECT count(*) FROM large_review_runs) AS runs,
         (SELECT count(*) FROM large_review_attempts) AS attempts`,
    );
    expect(counts.rows[0]).toEqual({ runs: "0", attempts: "0" });
  });

  test("rejects an active duplicate lease and reclaims only after expiry", async () => {
    const store = new PostgresLargeReviewAttemptStore(drizzle(pool, { schema }));
    const identity: LargeReviewRunIdentity = {
      repositoryId,
      prNumber: 1,
      cliVersion: "0.8.0",
      configurationSha256: "1".repeat(64),
      providerIdentity: '["managed","openai-compatible","https://example.test/v1"]',
      headSha: "2".repeat(40),
      baseSha: "0".repeat(40),
      retryLineage: "review-job:2",
      planSha256: "3".repeat(64),
    };
    const runKey = await store.bindRun(identity, {
      currentReviewId: reviewId,
      hostedReservationId: null,
    });
    const attempt = {
      runKey,
      requestSha256: "4".repeat(64),
      batchIdentity: "5".repeat(64),
      attempt: 1,
      model: "openai/test-model",
    };
    const first = await store.claimAttempt(attempt);
    expect(first.kind).toBe("execute");
    expect(await store.claimAttempt({ ...attempt, attempt: 2 })).toEqual({
      kind: "pending",
    });
    await pool.query(
      "UPDATE large_review_attempts SET lease_expires_at = now() - interval '1 second' WHERE attempt_key = $1",
      [largeReviewAttemptKey(attempt)],
    );
    const reclaimed = await store.claimAttempt({ ...attempt, attempt: 2 });
    expect(reclaimed.kind).toBe("execute");
    if (first.kind !== "execute" || reclaimed.kind !== "execute") {
      throw new Error("attempt lease was not executable");
    }
    await expect(
      store.completeAttempt({
        attemptKey: first.attemptKey,
        leaseId: first.leaseId,
        response: { status: 200, headers: {}, body: "old" },
      }),
    ).rejects.toThrow("lost its persistence lease");
    await store.completeAttempt({
      attemptKey: reclaimed.attemptKey,
      leaseId: reclaimed.leaseId,
      response: { status: 200, headers: {}, body: "new" },
    });
    expect(await store.claimAttempt(attempt)).toMatchObject({
      kind: "replay",
      response: { body: "new" },
    });
    await store.deleteRun(runKey);
  });

  test("removes expired journals before binding the next run", async () => {
    const store = new PostgresLargeReviewAttemptStore(drizzle(pool, { schema }));
    const identity: LargeReviewRunIdentity = {
      repositoryId,
      prNumber: 1,
      cliVersion: "0.8.0",
      configurationSha256: "6".repeat(64),
      providerIdentity: '["managed","openai-compatible","https://example.test/v1"]',
      headSha: "7".repeat(40),
      baseSha: "0".repeat(40),
      retryLineage: "review-job:3",
      planSha256: "8".repeat(64),
    };
    const context = { currentReviewId: reviewId, hostedReservationId: null };
    const expiredRunKey = await store.bindRun(identity, context);
    await pool.query(
      "UPDATE large_review_runs SET expires_at = now() - interval '1 second' WHERE run_key = $1",
      [expiredRunKey],
    );
    const activeRunKey = await store.bindRun(
      { ...identity, planSha256: "9".repeat(64) },
      context,
    );
    const keys = await pool.query<{ run_key: string }>(
      "SELECT run_key FROM large_review_runs ORDER BY run_key",
    );
    expect(keys.rows).toEqual([{ run_key: activeRunKey }]);
    await store.deleteRun(activeRunKey);
  });

  test("transfers one active hosted hold to a replacement review", async () => {
    const db = drizzle(pool, { schema });
    const store = new PostgresLargeReviewAttemptStore(db);
    const replacement = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source)
       VALUES ($1, 2, $2, $3, 'running', 'unknown')
       RETURNING id`,
      [repositoryId, "b".repeat(40), "0".repeat(40)],
    );
    const replacementReviewId = Number(replacement.rows[0]!.id);
    const reservation = await pool.query<{ id: string }>(
      `INSERT INTO hosted_usage_reservations
        (org_id, review_id, operation, reserved_micros, status, expires_at, updated_at)
       VALUES ($1, $2, 'review', 1000000, 'active', now() + interval '15 minutes', now())
       RETURNING id`,
      [orgId, reviewId],
    );
    const reservationId = reservation.rows[0]!.id;
    const identity: LargeReviewRunIdentity = {
      repositoryId,
      prNumber: 1,
      cliVersion: "0.8.0",
      configurationSha256: "a".repeat(64),
      providerIdentity: '["managed","openai-compatible","https://example.test/v1"]',
      headSha: "b".repeat(40),
      baseSha: "0".repeat(40),
      retryLineage: "review-job:4",
      planSha256: "c".repeat(64),
    };
    const runKey = await store.bindRun(identity, {
      currentReviewId: reviewId,
      hostedReservationId: reservationId,
    });
    await pool.query("UPDATE reviews SET status = 'failed' WHERE id = $1", [reviewId]);

    expect(
      await claimReusableLargeReviewReservation(
        db,
        { ...identity, prNumber: 99 },
        replacementReviewId,
      ),
    ).toEqual({ kind: "none" });
    expect(
      await claimReusableLargeReviewReservation(
        db,
        {
          repositoryId: identity.repositoryId,
          prNumber: identity.prNumber,
          cliVersion: identity.cliVersion,
          configurationSha256: identity.configurationSha256,
          providerIdentity: identity.providerIdentity,
          headSha: identity.headSha,
          baseSha: identity.baseSha,
          retryLineage: identity.retryLineage,
        },
        replacementReviewId,
      ),
    ).toEqual({ kind: "resume", reservationId, expectedRunKey: runKey });
    await expect(
      store.bindRun(identity, {
        currentReviewId: reviewId,
        hostedReservationId: reservationId,
        expectedRunKey: runKey,
      }),
    ).rejects.toThrow("context ownership collision");
    await expect(
      store.bindRun(
        { ...identity, planSha256: "d".repeat(64) },
        {
          currentReviewId: replacementReviewId,
          hostedReservationId: reservationId,
          expectedRunKey: runKey,
        },
      ),
    ).rejects.toThrow("plan changed across retry");
    const transferred = await pool.query<{
      review_id: string;
      status: string;
      run_review_id: string;
    }>(
      `SELECT reservation.review_id, reservation.status,
              run.current_review_id AS run_review_id
         FROM hosted_usage_reservations reservation
         JOIN large_review_runs run
           ON run.hosted_reservation_id = reservation.id
        WHERE run.run_key = $1`,
      [runKey],
    );
    expect(transferred.rows).toEqual([
      {
        review_id: String(replacementReviewId),
        status: "active",
        run_review_id: String(replacementReviewId),
      },
    ]);
    await store.deleteRun(runKey);
    await pool.query("DELETE FROM hosted_usage_reservations WHERE id = $1", [reservationId]);
  });

  test("settles one ambiguous run once and refuses another billed resume", async () => {
    const db = drizzle(pool, { schema });
    const store = new PostgresLargeReviewAttemptStore(db);
    const source = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source)
       VALUES ($1, 3, $2, $3, 'failed', 'unknown') RETURNING id`,
      [repositoryId, "e".repeat(40), "f".repeat(40)],
    );
    const sourceReviewId = Number(source.rows[0]!.id);
    const replacement = await pool.query<{ id: string }>(
      `INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source)
       VALUES ($1, 3, $2, $3, 'running', 'unknown') RETURNING id`,
      [repositoryId, "e".repeat(40), "f".repeat(40)],
    );
    const replacementReviewId = Number(replacement.rows[0]!.id);
    const reservation = await pool.query<{ id: string }>(
      `INSERT INTO hosted_usage_reservations
        (org_id, review_id, operation, reserved_micros, status, expires_at, updated_at)
       VALUES ($1, $2, 'review', 1000000, 'active', now() + interval '15 minutes', now())
       RETURNING id`,
      [orgId, sourceReviewId],
    );
    const reservationId = reservation.rows[0]!.id;
    const identity: LargeReviewRunIdentity = {
      repositoryId,
      prNumber: 3,
      cliVersion: "0.8.0",
      configurationSha256: "4".repeat(64),
      providerIdentity: '["managed","openai-compatible","https://example.test/v1","auth"]',
      headSha: "e".repeat(40),
      baseSha: "f".repeat(40),
      retryLineage: "review-job:ambiguous",
      planSha256: "5".repeat(64),
    };
    const runKey = await store.bindRun(identity, {
      currentReviewId: sourceReviewId,
      hostedReservationId: reservationId,
    });

    expect(
      await reconcileConservativeHostedReviewSpend(db, {
        reservationId,
        repositoryId,
        reviewId: sourceReviewId,
        triggerSource: "unknown",
        largeReviewRunKey: runKey,
      }),
    ).toBe(1_000_000);
    expect(
      await claimReusableLargeReviewReservation(
        db,
        {
          repositoryId: identity.repositoryId,
          prNumber: identity.prNumber,
          cliVersion: identity.cliVersion,
          configurationSha256: identity.configurationSha256,
          providerIdentity: identity.providerIdentity,
          headSha: identity.headSha,
          baseSha: identity.baseSha,
          retryLineage: identity.retryLineage,
        },
        replacementReviewId,
      ),
    ).toEqual({ kind: "conservatively-settled" });
    expect(
      await reconcileConservativeHostedReviewSpend(db, {
        reservationId,
        repositoryId,
        reviewId: sourceReviewId,
        triggerSource: "unknown",
        largeReviewRunKey: runKey,
      }),
    ).toBe(0);
    const charged = await pool.query<{ count: string; micros: string }>(
      `SELECT count(*)::text AS count, sum(cost_micros)::text AS micros
         FROM usage_events WHERE review_id = $1`,
      [sourceReviewId],
    );
    expect(charged.rows[0]).toEqual({ count: "1", micros: "1000000" });
    await store.deleteRun(runKey);
  });

  test("replays a completed batch after the proxy process is killed and restarted", async () => {
    let providerCalls = 0;
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    const responseBody = JSON.stringify({
      id: "process-restart-response",
      choices: [{ message: { content: '{"summary":"complete","findings":[]}' } }],
      usage: { prompt_tokens: 20, completion_tokens: 4 },
    });
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        providerCalls += 1;
        return new Response(responseBody, {
          headers: { "content-type": "application/json", "x-request-id": "restart-1" },
        });
      },
    });
    const startChild = async () => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          join(import.meta.dir, "fixtures", "large-review-resume-proxy-child.ts"),
        ],
        cwd: join(import.meta.dir, ".."),
        env: {
          PATH: process.env.PATH ?? "",
          DATABASE_URL: databaseUrl,
          POSTIL_TEST_REPOSITORY_ID: String(repositoryId),
          POSTIL_TEST_REVIEW_ID: String(reviewId),
          POSTIL_TEST_UPSTREAM_API_BASE: `http://127.0.0.1:${upstream.port}/v1`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      const line = await Promise.race([
        readFirstLine(child.stdout),
        Bun.sleep(5_000).then(() => {
          throw new Error("large-review proxy child did not start");
        }),
      ]);
      return {
        child,
        apiBase: (JSON.parse(line) as { apiBase: string }).apiBase,
      };
    };
    const body = JSON.stringify({
      model: "openai/test-model",
      messages: [{ role: "user", content: "review durable batch" }],
    });
    try {
      const first = await startChild();
      const original = await fetch(`${first.apiBase}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(await original.text()).toBe(responseBody);
      expect(original.headers.get("x-request-id")).toBe("restart-1");
      expect(providerCalls).toBe(1);
      first.child.kill("SIGKILL");
      await first.child.exited;

      const second = await startChild();
      const replay = await fetch(`${second.apiBase}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(await replay.text()).toBe(responseBody);
      expect(replay.headers.get("x-request-id")).toBe("restart-1");
      expect(providerCalls).toBe(1);
      second.child.kill("SIGKILL");
      await second.child.exited;

      const runKey = largeReviewRunKey({
        repositoryId,
        prNumber: 1,
        cliVersion: "0.8.0",
        configurationSha256: "a".repeat(64),
        providerIdentity: '["managed","openai-compatible","http://fixture/v1"]',
        headSha: "b".repeat(40),
        baseSha: "0".repeat(40),
        retryLineage: "review-job:fixture",
        planSha256: "c".repeat(64),
      });
      const state = await pool.query<{ state: string; response_body: string }>(
        "SELECT state, response_body FROM large_review_attempts WHERE run_key = $1",
        [runKey],
      );
      expect(state.rows).toEqual([{ state: "completed", response_body: responseBody }]);
      await new PostgresLargeReviewAttemptStore(drizzle(pool, { schema })).deleteRun(runKey);
    } finally {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process already exited.
        }
      }
      await Promise.allSettled(children.map((child) => child.exited));
      upstream.stop(true);
    }
  }, 20_000);
});

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("large-review proxy child exited before startup");
      buffered += decoder.decode(chunk.value, { stream: true });
      const newline = buffered.indexOf("\n");
      if (newline >= 0) return buffered.slice(0, newline);
    }
  } finally {
    reader.releaseLock();
  }
}
