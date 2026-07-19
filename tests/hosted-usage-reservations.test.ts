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
import {
  canProcessRepositoryInference,
  providerModeMatchesRepositoryAccess,
} from "@/lib/private-repository-entitlement";
import {
  claimRespondDelivery,
  getRespondDelivery,
  markRespondDelivered,
  recoverRespondDeliveryJobs,
  RESPOND_DELIVERY_MAX_ATTEMPTS,
} from "@/lib/respond-delivery";

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
      INSERT INTO reviews
        (repository_id, pr_number, head_sha, base_sha, status, trigger_source, trigger_context)
      VALUES
        (${repositoryId}, 1, 'head-1', 'base', 'running', 'unknown', NULL),
        (${repositoryId}, 2, 'head-2', 'base', 'running', 'requested_review',
         '{"source":"requested_review","webhookDeliveryId":"billing-test","webhookEvent":"issue_comment"}'::jsonb)
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
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminClient) {
      await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminClient.end();
    }
  }, 30_000);

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
        usage: [{
          orgId,
          repositoryId,
          promptTokens: 100,
          completionTokens: 10,
          modelUsed: "z-ai/glm-5.2",
          costMicros: 1_234,
          billingScope: "private_hosted",
        }],
        hostedUsageReservationId: recovered.reservationId,
        usageAccountingComplete: false,
      }),
    ).toBe(true);
    const reconciled = await pool!.query<{ status: string; actual_micros: string }>(
      `SELECT status, actual_micros FROM hosted_usage_reservations WHERE id = $1`,
      [recovered.reservationId],
    );
    expect(reconciled.rows[0]).toEqual({ status: "reconciled", actual_micros: "1000000" });
    const usage = await pool!.query<{ cost_micros: string; trigger_source: string }>(
      `SELECT sum(cost_micros)::bigint AS cost_micros, max(trigger_source) AS trigger_source
       FROM usage_events WHERE review_id = $1`,
      [rejectedReviewId],
    );
    expect(usage.rows[0]).toEqual({
      cost_micros: "1000000",
      trigger_source:
        rejectedReviewId === reviewIds[1] ? "requested_review" : "unknown",
    });
  });

  test("public hosted access requires an active bounded entitlement while public BYOK does not", async () => {
    const db = drizzle(pool!, { schema });
    const withoutEntitlement = await pool!.query<{ id: string }>(
      "INSERT INTO organizations (slug, name) VALUES ('public-no-plan', 'Public no plan') RETURNING id",
    );
    const noPlanOrgId = Number(withoutEntitlement.rows[0]!.id);
    const publicNoPlan = await canProcessRepositoryInference(db, {
      orgId: noPlanOrgId,
      repositoryPrivate: false,
    });
    expect(providerModeMatchesRepositoryAccess(false, publicNoPlan, true)).toBe(true);
    expect(providerModeMatchesRepositoryAccess(false, publicNoPlan, false)).toBe(false);

    const trialOrg = await pool!.query<{ id: string }>(
      "INSERT INTO organizations (slug, name) VALUES ('public-trial', 'Public trial') RETURNING id",
    );
    const trialOrgId = Number(trialOrg.rows[0]!.id);
    await pool!.query(
      `INSERT INTO organization_entitlements
         (org_id, subscription_mode, status, trial_ends_at, period_starts_at,
          period_ends_at, included_usage_micros, overage_hard_cap_micros, updated_by)
       VALUES ($1, 'hosted', 'trialing', now() + interval '1 day', now(),
               now() + interval '1 day', 2000000, 0, 'test')`,
      [trialOrgId],
    );
    const activeTrial = await canProcessRepositoryInference(db, {
      orgId: trialOrgId,
      repositoryPrivate: false,
    });
    expect(activeTrial).toMatchObject({ allowed: true, reason: "active_trial" });
    expect(providerModeMatchesRepositoryAccess(false, activeTrial, false)).toBe(true);

    await pool!.query(
      "UPDATE organization_entitlements SET trial_ends_at = now() WHERE org_id = $1",
      [trialOrgId],
    );
    const expiredTrial = await canProcessRepositoryInference(db, {
      orgId: trialOrgId,
      repositoryPrivate: false,
    });
    expect(providerModeMatchesRepositoryAccess(false, expiredTrial, false)).toBe(false);

    const privateNoPlan = await canProcessRepositoryInference(db, {
      orgId: noPlanOrgId,
      repositoryPrivate: true,
    });
    expect(privateNoPlan).toMatchObject({ allowed: false, reason: "no_entitlement" });
  });

  test("classifies omitted legacy usage scope without undercounting private hosted work", async () => {
    const legacyHosted = await pool!.query<{ billing_scope: string }>(
      `INSERT INTO usage_events (
         org_id, repository_id, prompt_tokens, completion_tokens, model_used, cost_micros
       ) VALUES ($1, $2, 10, 2, 'legacy-hosted', 77)
       RETURNING billing_scope`,
      [orgId, repositoryId],
    );
    expect(legacyHosted.rows[0]?.billing_scope).toBe("private_hosted");

    const explicitAnalytics = await pool!.query<{ billing_scope: string }>(
      `INSERT INTO usage_events (
         org_id, repository_id, prompt_tokens, completion_tokens, model_used,
         cost_micros, billing_scope
       ) VALUES ($1, $2, 10, 2, 'current-explicit', 77, 'analytics')
       RETURNING billing_scope`,
      [orgId, repositoryId],
    );
    expect(explicitAnalytics.rows[0]?.billing_scope).toBe("analytics");

    await pool!.query(
      "UPDATE organization_entitlements SET subscription_mode = 'byok' WHERE org_id = $1",
      [orgId],
    );
    const entitlementSaysByokWithoutKey = await pool!.query<{ billing_scope: string }>(
      `INSERT INTO usage_events (
         org_id, repository_id, prompt_tokens, completion_tokens, model_used, cost_micros
       ) VALUES ($1, $2, 10, 2, 'legacy-entitlement-byok-without-key', 77)
       RETURNING billing_scope`,
      [orgId, repositoryId],
    );
    expect(entitlementSaysByokWithoutKey.rows[0]?.billing_scope).toBe("private_hosted");
    await pool!.query(
      "UPDATE organization_entitlements SET subscription_mode = 'hosted' WHERE org_id = $1",
      [orgId],
    );
    await pool!.query(
      `INSERT INTO org_settings (org_id, api_key_ciphertext)
       VALUES ($1, decode('010203', 'hex'))
       ON CONFLICT (org_id) DO UPDATE SET api_key_ciphertext = EXCLUDED.api_key_ciphertext`,
      [orgId],
    );
    const entitlementSaysHostedWithKey = await pool!.query<{ billing_scope: string }>(
      `INSERT INTO usage_events (
         org_id, repository_id, prompt_tokens, completion_tokens, model_used, cost_micros
       ) VALUES ($1, $2, 10, 2, 'legacy-entitlement-hosted-with-key', 77)
       RETURNING billing_scope`,
      [orgId, repositoryId],
    );
    expect(entitlementSaysHostedWithKey.rows[0]?.billing_scope).toBe("analytics");
    await pool!.query("DELETE FROM org_settings WHERE org_id = $1", [orgId]);
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
      usageAccountingComplete: true,
      triggerSource: "github_mention",
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
      trigger_source: string;
    }>(
      `SELECT review_id, prompt_tokens, completion_tokens, cost_micros, trigger_source
       FROM usage_events WHERE repository_id = $1 AND review_id IS NULL`,
      [respondRepositoryId],
    );
    expect(usage.rows[0]).toEqual({
      review_id: null,
      prompt_tokens: 120,
      completion_tokens: 20,
      cost_micros: "987",
      trigger_source: "github_mention",
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
      usageAccountingComplete: false,
    });
    const conservative = await pool!.query<{ actual_micros: string }>(
      `SELECT actual_micros FROM hosted_usage_reservations WHERE id = $1`,
      [unmetered.reservationId],
    );
    expect(conservative.rows[0]?.actual_micros).toBe("1000000");
  });

  test("unpriced hosted review charges one reservation without poisoning later capacity", async () => {
    const db = drizzle(pool!, { schema });
    const fixture = await pool!.query<{
      org_id: string;
      repository_id: string;
      first_review_id: string;
      second_review_id: string;
    }>(`
      WITH org AS (
        INSERT INTO organizations (slug, name) VALUES ('unpriced-review', 'Unpriced Review') RETURNING id
      ), installation AS (
        INSERT INTO installations (github_installation_id, account_login, account_type, org_id)
        SELECT 99417, 'unpriced-review', 'Organization', id FROM org RETURNING id, org_id
      ), repository AS (
        INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
        SELECT id, 99418, 'unpriced-review/private', true, true FROM installation RETURNING id
      ), reviews AS (
        INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status)
        SELECT id, 1, 'unpriced-review-1', 'base', 'running'::review_status FROM repository
        UNION ALL
        SELECT id, 2, 'unpriced-review-2', 'base', 'running'::review_status FROM repository
        RETURNING id, pr_number
      ), entitlement AS (
        INSERT INTO organization_entitlements (
          org_id, subscription_mode, status, included_usage_micros,
          overage_hard_cap_micros, included_usage_cents, overage_hard_cap_cents, updated_by
        ) SELECT org_id, 'hosted', 'active', 3000000, 0, 300, 0, 'test' FROM installation
      )
      SELECT installation.org_id, repository.id AS repository_id,
        min(reviews.id) FILTER (WHERE reviews.pr_number = 1) AS first_review_id,
        min(reviews.id) FILTER (WHERE reviews.pr_number = 2) AS second_review_id
      FROM installation, repository, reviews
      GROUP BY installation.org_id, repository.id;
    `);
    const row = fixture.rows[0]!;
    const first = await reserveHostedReviewSpend(db, {
      orgId: Number(row.org_id),
      reviewId: Number(row.first_review_id),
      usesByok: false,
    });
    expect(first.allowed).toBe(true);
    expect(await persistReviewCompletion(db, {
      reviewId: Number(row.first_review_id),
      envelope: { version: 1 } as Envelope,
      configFiles: [],
      silent: true,
      gateFailing: false,
      usage: [
        {
          orgId: Number(row.org_id), repositoryId: Number(row.repository_id),
          promptTokens: 100, completionTokens: 10, modelUsed: "known-model",
          costMicros: 125, billingScope: "private_hosted",
        },
        {
          orgId: Number(row.org_id), repositoryId: Number(row.repository_id),
          promptTokens: 50, completionTokens: 5, modelUsed: "unknown-model",
          costMicros: null, billingScope: "private_hosted",
        },
      ],
      hostedUsageReservationId: first.reservationId,
      usageAccountingComplete: true,
    })).toBe(true);
    const usage = await pool!.query<{ null_costs: number; total_micros: string }>(
      `SELECT count(*) FILTER (WHERE cost_micros IS NULL)::int AS null_costs,
              sum(cost_micros)::bigint AS total_micros
       FROM usage_events WHERE review_id = $1 AND billing_scope = 'private_hosted'`,
      [row.first_review_id],
    );
    expect(usage.rows[0]).toEqual({ null_costs: 0, total_micros: "1000000" });
    const second = await reserveHostedReviewSpend(db, {
      orgId: Number(row.org_id),
      reviewId: Number(row.second_review_id),
      usesByok: false,
    });
    expect(second).toMatchObject({ allowed: true, committedMicros: 1_000_000 });
  });

  test("unpriced hosted response charges one reservation without poisoning later capacity", async () => {
    const db = drizzle(pool!, { schema });
    const fixture = await pool!.query<{ org_id: string; repository_id: string }>(`
      WITH org AS (
        INSERT INTO organizations (slug, name) VALUES ('unpriced-respond', 'Unpriced Respond') RETURNING id
      ), installation AS (
        INSERT INTO installations (github_installation_id, account_login, account_type, org_id)
        SELECT 99517, 'unpriced-respond', 'Organization', id FROM org RETURNING id, org_id
      ), repository AS (
        INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
        SELECT id, 99518, 'unpriced-respond/private', true, true FROM installation RETURNING id
      ), entitlement AS (
        INSERT INTO organization_entitlements (
          org_id, subscription_mode, status, included_usage_micros,
          overage_hard_cap_micros, included_usage_cents, overage_hard_cap_cents, updated_by
        ) SELECT org_id, 'hosted', 'active', 3000000, 0, 300, 0, 'test' FROM installation
      )
      SELECT installation.org_id, repository.id AS repository_id FROM installation, repository;
    `);
    const row = fixture.rows[0]!;
    const first = await reserveHostedRespondSpend(db, {
      orgId: Number(row.org_id), usesByok: false,
    });
    expect(first.allowed).toBe(true);
    await reconcileHostedRespondSpend(db, {
      reservationId: first.reservationId!,
      repositoryId: Number(row.repository_id),
      promptTokens: 80,
      completionTokens: 8,
      modelUsed: "unknown-model",
      actualMicros: null,
      usageAccountingComplete: true,
    });
    const usage = await pool!.query<{ null_costs: number; total_micros: string }>(
      `SELECT count(*) FILTER (WHERE cost_micros IS NULL)::int AS null_costs,
              sum(cost_micros)::bigint AS total_micros
       FROM usage_events
       WHERE org_id = $1 AND repository_id = $2 AND review_id IS NULL
         AND billing_scope = 'private_hosted'`,
      [row.org_id, row.repository_id],
    );
    expect(usage.rows[0]).toEqual({ null_costs: 0, total_micros: "1000000" });
    const second = await reserveHostedRespondSpend(db, {
      orgId: Number(row.org_id), usesByok: false,
    });
    expect(second).toMatchObject({ allowed: true, committedMicros: 1_000_000 });
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

  test("respond receipt and prepared delivery commit together, with one retry lease owner", async () => {
    const db = drizzle(pool!, { schema });
    const fixture = await pool!.query<{
      org_id: string;
      repository_id: string;
      job_id: string;
    }>(`
      WITH org AS (
        INSERT INTO organizations (slug, name)
        VALUES ('delivery-metering', 'Delivery Metering') RETURNING id
      ), installation AS (
        INSERT INTO installations (github_installation_id, account_login, account_type, org_id)
        SELECT 99317, 'delivery-metering', 'Organization', id FROM org RETURNING id, org_id
      ), repository AS (
        INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
        SELECT id, 99318, 'delivery-metering/private', true, true FROM installation
        RETURNING id
      ), entitlement AS (
        INSERT INTO organization_entitlements (
          org_id, subscription_mode, status, included_usage_micros,
          overage_hard_cap_micros, included_usage_cents, overage_hard_cap_cents,
          updated_by
        ) SELECT org_id, 'hosted', 'active', 1000000, 0, 100, 0, 'test'
        FROM installation
      ), job AS (
        INSERT INTO jobs (kind, payload) VALUES ('respond', '{}') RETURNING id
      )
      SELECT installation.org_id, repository.id AS repository_id, job.id AS job_id
      FROM installation, repository, job;
    `);
    const row = fixture.rows[0]!;
    await pool!.query(
      `INSERT INTO usage_events (
        org_id, repository_id, prompt_tokens, completion_tokens, model_used,
        cost_micros, billing_scope
      ) VALUES ($1, $2, 1000000, 0, 'analytics-model', 1000000, 'analytics')`,
      [row.org_id, row.repository_id],
    );
    const reservation = await reserveHostedRespondSpend(db, {
      orgId: Number(row.org_id),
      usesByok: false,
    });
    // Analytics events, including public reviews, never consume the private
    // hosted allowance despite carrying provider-cost telemetry.
    expect(reservation.allowed).toBe(true);
    await reconcileHostedRespondSpend(db, {
      reservationId: reservation.reservationId!,
      repositoryId: Number(row.repository_id),
      promptTokens: 12,
      completionTokens: 3,
      modelUsed: "z-ai/glm-5.2",
      actualMicros: 321,
      usageAccountingComplete: false,
      delivery: {
        jobId: Number(row.job_id),
        repoFullName: "delivery-metering/private",
        issueNumber: 4,
        body: "Prepared answer\n\n<!-- postil-respond-job:4 -->",
      },
    });
    const durable = await pool!.query<{ cost_micros: string; state: string }>(`
      SELECT sum(usage.cost_micros)::bigint AS cost_micros, max(delivery.state) AS state
      FROM usage_events usage
      JOIN respond_deliveries delivery ON delivery.job_id = ${Number(row.job_id)}
      WHERE usage.repository_id = ${Number(row.repository_id)}
        AND usage.billing_scope = 'private_hosted'
      GROUP BY delivery.job_id
    `);
    expect(durable.rows[0]).toEqual({ cost_micros: "1000000", state: "prepared" });
    const deliveryJob = await pool!.query<{ max_attempts: number }>(`
      SELECT max_attempts
      FROM jobs
      WHERE kind = 'respond-delivery'
        AND payload @> jsonb_build_object('respondJobId', ${Number(row.job_id)}::bigint)
    `);
    expect(deliveryJob.rows).toEqual([{ max_attempts: RESPOND_DELIVERY_MAX_ATTEMPTS }]);
    await pool!.query(
      `DELETE FROM jobs WHERE kind = 'respond-delivery' AND payload @> jsonb_build_object('respondJobId', $1::bigint)`,
      [row.job_id],
    );
    expect(await recoverRespondDeliveryJobs(db)).toBe(1);
    expect(await recoverRespondDeliveryJobs(db)).toBe(0);

    const claims = await Promise.all([
      claimRespondDelivery(db, Number(row.job_id)),
      claimRespondDelivery(db, Number(row.job_id)),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await pool!.query(
      `UPDATE respond_deliveries SET delivery_lease_expires_at = now() - interval '1 second' WHERE job_id = $1`,
      [row.job_id],
    );
    expect(await claimRespondDelivery(db, Number(row.job_id))).not.toBeNull();
    await markRespondDelivered(db, Number(row.job_id), 7788);
    expect(await getRespondDelivery(db, Number(row.job_id))).toMatchObject({
      state: "delivered",
    });
  });
});
