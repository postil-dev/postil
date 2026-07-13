import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

import {
  hasHostedReservationCapacity,
  reconcileHostedRespondSpend,
  releaseHostedRespondSpend,
  reserveHostedReviewSpend,
  reserveHostedRespondSpend,
} from "@/lib/hosted-usage-reservations";
import * as schema from "@/lib/db/schema";
import type { Envelope } from "@/lib/envelope";
import { persistReviewCompletion } from "@/lib/review-completion";

describe("hosted usage reservation arithmetic", () => {
  test("includes committed and every concurrent active hold", () => {
    expect(
      hasHostedReservationCapacity({
        committedMicros: 100,
        activeReservedMicros: 200,
        requestedMicros: 250,
        usageLimitMicros: 550,
      }),
    ).toBe(true);
    expect(
      hasHostedReservationCapacity({
        committedMicros: 100,
        activeReservedMicros: 201,
        requestedMicros: 250,
        usageLimitMicros: 550,
      }),
    ).toBe(false);
  });
});

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("hosted usage reservations on PostgreSQL", () => {
  const databaseName = `postil_usage_reservations_${process.pid}_${Date.now()}`;
  let adminClient: Client | undefined;
  let pool: Pool | undefined;
  let orgId = 0;
  let repositoryId = 0;
  let reviewIds: number[] = [];

  beforeAll(async () => {
    adminClient = new Client({ connectionString: TEST_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    const migrationClient = new Client({ connectionString: databaseUrl.toString() });
    await migrationClient.connect();
    const migrationsDir = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .sort();
    for (const file of migrations) {
      const source = await readFile(join(migrationsDir, file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migrationClient.query(statement);
      }
    }
    const fixture = await migrationClient.query<{ id: string }>(`
      INSERT INTO organizations (slug, name) VALUES ('metering', 'Metering') RETURNING id;
    `);
    orgId = Number(fixture.rows[0]?.id);
    const installation = await migrationClient.query<{ id: string }>(`
      INSERT INTO installations (github_installation_id, account_login, account_type, org_id)
      VALUES (99117, 'metering', 'Organization', ${orgId}) RETURNING id;
    `);
    const repository = await migrationClient.query<{ id: string }>(`
      INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
      VALUES (${Number(installation.rows[0]?.id)}, 99118, 'metering/private', true, true)
      RETURNING id;
    `);
    repositoryId = Number(repository.rows[0]?.id);
    const reviews = await migrationClient.query<{ id: string }>(`
      INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status)
      VALUES
        (${repositoryId}, 1, 'head-1', 'base', 'running'),
        (${repositoryId}, 2, 'head-2', 'base', 'running')
      RETURNING id;
    `);
    reviewIds = reviews.rows.map((row) => Number(row.id));
    await migrationClient.query(`
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, included_usage_micros,
        overage_hard_cap_micros, included_usage_cents, overage_hard_cap_cents,
        updated_by
      ) VALUES (${orgId}, 'hosted', 'active', 1000000, 0, 100, 0, 'test');
    `);
    await migrationClient.end();
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminClient) {
      await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminClient.end();
    }
  });

  test("row locking admits only one concurrent hold and recovers an expired hold", async () => {
    const db = drizzle(pool!, { schema });
    const decisions = await Promise.all(
      reviewIds.map((reviewId) =>
        reserveHostedReviewSpend(db, { orgId, reviewId, usesByok: false }),
      ),
    );
    const first = decisions[0]!;
    const second = decisions[1]!;
    expect([first.allowed, second.allowed].sort()).toEqual([false, true]);
    const accepted = first.allowed ? first : second;
    const rejectedReviewId = first.allowed ? reviewIds[1]! : reviewIds[0]!;
    await pool!.query(
      `UPDATE hosted_usage_reservations SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [accepted.reservationId],
    );
    const recovered = await reserveHostedReviewSpend(db, {
      orgId,
      reviewId: rejectedReviewId,
      usesByok: false,
    });
    expect(recovered).toMatchObject({ allowed: true, reason: "reserved" });
    const statuses = await pool!.query<{ status: string }>(
      `SELECT status FROM hosted_usage_reservations ORDER BY created_at, review_id`,
    );
    expect(statuses.rows.map((row) => row.status).sort()).toEqual(["active", "released"]);

    expect(
      await persistReviewCompletion(db, {
        reviewId: rejectedReviewId,
        envelope: { version: 1 } as Envelope,
        configFiles: [],
        silent: true,
        gateFailing: false,
        usage: {
          orgId,
          repositoryId,
          promptTokens: 100,
          completionTokens: 10,
          modelUsed: "z-ai/glm-5.2",
          costMicros: 1_234,
        },
        hostedUsageReservationId: recovered.reservationId,
      }),
    ).toBe(true);
    const reconciled = await pool!.query<{ status: string; actual_micros: string }>(
      `SELECT status, actual_micros FROM hosted_usage_reservations WHERE id = $1`,
      [recovered.reservationId],
    );
    expect(reconciled.rows[0]).toEqual({ status: "reconciled", actual_micros: "1234" });
    const usage = await pool!.query<{ cost_micros: string }>(
      `SELECT cost_micros FROM usage_events WHERE review_id = $1`,
      [rejectedReviewId],
    );
    expect(usage.rows[0]).toEqual({ cost_micros: "1234" });
  });

  test("respond holds serialize, reconcile without a review, and release on failure", async () => {
    const db = drizzle(pool!, { schema });
    const fixture = await pool!.query<{ org_id: string; repository_id: string }>(`
      WITH org AS (
        INSERT INTO organizations (slug, name)
        VALUES ('respond-metering', 'Respond Metering') RETURNING id
      ), installation AS (
        INSERT INTO installations (github_installation_id, account_login, account_type, org_id)
        SELECT 99217, 'respond-metering', 'Organization', id FROM org RETURNING id, org_id
      ), repository AS (
        INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
        SELECT id, 99218, 'respond-metering/private', true, true FROM installation
        RETURNING id
      ), entitlement AS (
        INSERT INTO organization_entitlements (
          org_id, subscription_mode, status, included_usage_micros,
          overage_hard_cap_micros, included_usage_cents, overage_hard_cap_cents,
          updated_by
        ) SELECT org_id, 'hosted', 'active', 1000000, 0, 100, 0, 'test'
        FROM installation
      )
      SELECT installation.org_id, repository.id AS repository_id
      FROM installation, repository;
    `);
    const respondOrgId = Number(fixture.rows[0]!.org_id);
    const respondRepositoryId = Number(fixture.rows[0]!.repository_id);
    const decisions = await Promise.all([
      reserveHostedRespondSpend(db, { orgId: respondOrgId, usesByok: false }),
      reserveHostedRespondSpend(db, { orgId: respondOrgId, usesByok: false }),
    ]);
    expect(decisions.map((decision) => decision.allowed).sort()).toEqual([false, true]);
    const accepted = decisions.find((decision) => decision.allowed)!;
    expect(accepted.reservationId).not.toBeNull();
    await reconcileHostedRespondSpend(db, {
      reservationId: accepted.reservationId!,
      repositoryId: respondRepositoryId,
      promptTokens: 120,
      completionTokens: 20,
      modelUsed: "z-ai/glm-5.2",
      actualMicros: 987,
    });
    const reconciled = await pool!.query<{
      operation: string;
      review_id: string | null;
      status: string;
      actual_micros: string;
    }>(
      `SELECT operation, review_id, status, actual_micros
       FROM hosted_usage_reservations WHERE id = $1`,
      [accepted.reservationId],
    );
    expect(reconciled.rows[0]).toEqual({
      operation: "respond",
      review_id: null,
      status: "reconciled",
      actual_micros: "987",
    });
    const usage = await pool!.query<{
      review_id: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      cost_micros: string;
    }>(
      `SELECT review_id, prompt_tokens, completion_tokens, cost_micros
       FROM usage_events WHERE repository_id = $1 AND review_id IS NULL`,
      [respondRepositoryId],
    );
    expect(usage.rows[0]).toEqual({
      review_id: null,
      prompt_tokens: 120,
      completion_tokens: 20,
      cost_micros: "987",
    });

    await pool!.query(
      `UPDATE organization_entitlements SET included_usage_micros = 2000000 WHERE org_id = $1`,
      [respondOrgId],
    );
    const failedAttempt = await reserveHostedRespondSpend(db, {
      orgId: respondOrgId,
      usesByok: false,
    });
    expect(failedAttempt.allowed).toBe(true);
    await releaseHostedRespondSpend(db, failedAttempt.reservationId);
    const released = await pool!.query<{ status: string }>(
      `SELECT status FROM hosted_usage_reservations WHERE id = $1`,
      [failedAttempt.reservationId],
    );
    expect(released.rows[0]?.status).toBe("released");

    const unmetered = await reserveHostedRespondSpend(db, {
      orgId: respondOrgId,
      usesByok: false,
    });
    await reconcileHostedRespondSpend(db, {
      reservationId: unmetered.reservationId!,
      repositoryId: respondRepositoryId,
      promptTokens: 0,
      completionTokens: 0,
      modelUsed: "respond (conservative reservation)",
      actualMicros: null,
    });
    const conservative = await pool!.query<{ actual_micros: string }>(
      `SELECT actual_micros FROM hosted_usage_reservations WHERE id = $1`,
      [unmetered.reservationId],
    );
    expect(conservative.rows[0]?.actual_micros).toBe("1000000");
  });

  test("BYOK respond bypasses hosted reservations", async () => {
    const db = drizzle(pool!, { schema });
    await pool!.query(
      `UPDATE organization_entitlements SET subscription_mode = 'byok' WHERE org_id = $1`,
      [orgId],
    );
    const decision = await reserveHostedRespondSpend(db, {
      orgId,
      usesByok: true,
    });
    expect(decision).toMatchObject({ allowed: true, reason: "not_hosted", reservationId: null });
  });
});
