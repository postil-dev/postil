import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import { hostedInferenceAvailable } from "@/lib/env";
import * as schema from "@/lib/db/schema";
import {
  canProcessRepositoryInference,
  providerModeMatchesRepositoryAccess,
} from "@/lib/private-repository-entitlement";
import {
  activateHostedInferenceRelease,
  deactivateHostedInferenceRelease,
  deferHostedReviewForRelease,
  hostedInferenceReleaseActivated,
} from "@/lib/release-job-rollout";
import { HOSTED_REVIEW_UNAVAILABLE_MESSAGE } from "@/lib/review-outcome";
import { backfillSelfServiceTrials } from "@/lib/self-service-trial";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("managed hosted inference release activation", () => {
  const databaseName = `postil_hosted_activation_${process.pid}_${Date.now()}`;
  const releaseA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const releaseB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const releaseC = "cccccccccccccccccccccccccccccccccccccccc";
  const releaseD = "dddddddddddddddddddddddddddddddddddddddd";
  const releaseE = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const releaseF = "ffffffffffffffffffffffffffffffffffffffff";
  let admin: Client;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(TEST_URL!);
    url.pathname = `/${databaseName}`;
    const migration = new Client({ connectionString: url.toString() });
    await migration.connect();
    for (const file of (await readdir(join(import.meta.dir, "..", "drizzle")))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort()) {
      const source = await readFile(
        join(import.meta.dir, "..", "drizzle", file),
        "utf8",
      );
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migration.query(statement);
      }
    }
    await migration.end();
    pool = new Pool({ connectionString: url.toString() });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin?.end();
    delete process.env.POSTIL_RELEASE_SHA;
    delete process.env.POSTIL_HOSTED_INFERENCE_ENABLED;
    delete process.env.POSTIL_OPERATOR_ALERT_EMAIL;
  }, 30_000);

  test("deploys dark, activates only the exact release, and deactivates on rollback", async () => {
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    process.env.POSTIL_RELEASE_SHA = releaseA;

    expect(await hostedInferenceAvailable(pool)).toBe(false);
    const darkTrial = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('dark-trial', 'Dark Trial', 71001) RETURNING id
    `);
    const darkTrialOrgId = Number(darkTrial.rows[0]!.id);
    await pool.query(
      `
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, trial_ends_at, period_starts_at,
        period_ends_at, included_usage_micros, overage_hard_cap_micros,
        updated_by
      ) VALUES ($1, 'byok', 'trialing', now() + interval '30 days', now(),
                now() + interval '30 days', 100000000, 0, 'self-service-trial')
    `,
      [darkTrialOrgId],
    );
    await pool.query(
      `
      INSERT INTO self_service_trial_grants (
        org_id, initiated_by_github_id, requested_mode, granted_mode
      ) VALUES ($1, 72001, 'hosted', 'byok')
    `,
      [darkTrialOrgId],
    );
    const manualTrial = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('manual-byok-trial', 'Manual BYOK Trial', 71002) RETURNING id
    `);
    const manualTrialOrgId = Number(manualTrial.rows[0]!.id);
    await pool.query(
      `
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, trial_ends_at, period_starts_at,
        period_ends_at, included_usage_micros, overage_hard_cap_micros,
        updated_by
      ) VALUES ($1, 'byok', 'trialing', now() + interval '30 days', now(),
                now() + interval '30 days', 100000000, 0, 'trial-provider-mode')
    `,
      [manualTrialOrgId],
    );
    await pool.query(
      `
      INSERT INTO self_service_trial_grants (
        org_id, initiated_by_github_id, requested_mode, granted_mode
      ) VALUES ($1, 72002, 'hosted', 'byok')
    `,
      [manualTrialOrgId],
    );

    await expect(
      activateHostedInferenceRelease(pool, "invalid release"),
    ).rejects.toThrow("requires a release SHA");
    expect(
      (
        await pool.query<{ subscription_mode: string }>(
          "SELECT subscription_mode FROM organization_entitlements WHERE org_id = $1",
          [darkTrialOrgId],
        )
      ).rows[0]!.subscription_mode,
    ).toBe("byok");

    expect(await activateHostedInferenceRelease(pool, releaseA)).toBe(true);
    expect(await hostedInferenceAvailable(pool)).toBe(true);
    expect(
      (
        await pool.query<{ subscription_mode: string; granted_mode: string }>(
          `
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `,
          [darkTrialOrgId],
        )
      ).rows[0],
    ).toEqual({
      subscription_mode: "hosted",
      granted_mode: "hosted",
    });
    expect(
      (
        await pool.query<{ subscription_mode: string; granted_mode: string }>(
          `
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `,
          [manualTrialOrgId],
        )
      ).rows[0],
    ).toEqual({
      subscription_mode: "byok",
      granted_mode: "byok",
    });
    const access = await canProcessRepositoryInference(
      drizzle(pool, { schema }),
      { orgId: darkTrialOrgId, repositoryPrivate: true },
    );
    expect(access).toMatchObject({ allowed: true, reason: "active_trial" });
    expect(providerModeMatchesRepositoryAccess(true, access, false)).toBe(true);
    expect(await hostedInferenceReleaseActivated(pool, releaseB)).toBe(false);

    process.env.POSTIL_RELEASE_SHA = releaseB;
    expect(await hostedInferenceAvailable(pool)).toBe(false);
    expect(await activateHostedInferenceRelease(pool, releaseB)).toBe(true);
    expect(await hostedInferenceAvailable(pool)).toBe(true);
    expect(await deactivateHostedInferenceRelease(pool, releaseB)).toBe(true);
    expect(await hostedInferenceAvailable(pool)).toBe(false);

    process.env.POSTIL_RELEASE_SHA = releaseA;
    expect(await hostedInferenceAvailable(pool)).toBe(true);
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    expect(await hostedInferenceAvailable(pool)).toBe(false);
  });

  test("activation revives only unowned automatic reviews consumed by a dark release", async () => {
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    process.env.POSTIL_RELEASE_SHA = releaseD;
    await deactivateHostedInferenceRelease(pool, releaseD);
    const organization = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('dark-review-reconcile', 'Dark review reconcile', 75001)
      RETURNING id
    `);
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, org_id, account_login, account_type, suspended)
       VALUES (75002, $1, 'dark-review-reconcile', 'Organization', false)
       RETURNING id`,
      [organization.rows[0]!.id],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
         (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, 75003, 'dark-review-reconcile/repo', false, true)
       RETURNING id`,
      [installation.rows[0]!.id],
    );
    const reviewJob = (deliveryId: string, prNumber: number, headSha: string) => ({
      installationId: 75002,
      sourceInstallationId: Number(installation.rows[0]!.id),
      sourceOrgId: Number(organization.rows[0]!.id),
      githubRepoId: 75003,
      repoFullName: "dark-review-reconcile/repo",
      repositoryPrivate: false,
      prNumber,
      headSha,
      baseSha: "base",
      sourceDeliveryId: deliveryId,
      trigger: {
        source: "automatic_pull_request",
        webhookDeliveryId: deliveryId,
        webhookEvent: "pull_request",
        webhookAction: prNumber === 31 ? "opened" : "synchronize",
      },
    });
    const missedPayload = reviewJob("dark-opened", 31, "missed-head");
    const ownedPayload = reviewJob("dark-synchronize", 32, "owned-head");
    const jobs = await pool.query<{ id: string; delivery: string }>(
      `INSERT INTO jobs (kind, payload, status)
       VALUES ('review', $1::jsonb, 'done'), ('review', $2::jsonb, 'done')
       RETURNING id, payload->>'sourceDeliveryId' AS delivery`,
      [JSON.stringify(missedPayload), JSON.stringify(ownedPayload)],
    );
    for (const payload of [missedPayload, ownedPayload]) {
      await pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, status, error_message,
            trigger_source, trigger_context, queued_at, started_at, finished_at)
         VALUES ($1, $2, $3, 'base', 'failed', $4,
                 'automatic_pull_request', $5::jsonb, now(), now(), now())`,
        [
          repository.rows[0]!.id,
          payload.prNumber,
          payload.headSha,
          HOSTED_REVIEW_UNAVAILABLE_MESSAGE,
          JSON.stringify(payload.trigger),
        ],
      );
    }
    await pool.query(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, envelope, finished_at)
       VALUES ($1, 32, 'owned-head', 'base', 'completed', '{}'::jsonb, now())`,
      [repository.rows[0]!.id],
    );

    expect(await activateHostedInferenceRelease(pool, releaseD)).toBe(true);
    const states = await pool.query<{ delivery: string; status: string }>(
      `SELECT payload->>'sourceDeliveryId' AS delivery, status
         FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY delivery`,
      [jobs.rows.map((row) => row.id)],
    );
    expect(states.rows).toEqual([
      { delivery: "dark-opened", status: "queued" },
      { delivery: "dark-synchronize", status: "done" },
    ]);
    expect(await activateHostedInferenceRelease(pool, releaseD)).toBe(false);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs
        WHERE kind = 'review' AND payload->>'headSha' = 'missed-head'`,
    )).rows[0]!.count).toBe(1);
  });

  test("a verified successor release adopts work parked by an unactivated release", async () => {
    await deactivateHostedInferenceRelease(pool, releaseE);
    const job = await pool.query<{ id: string; status: string; locked_by: string | null }>(
      `INSERT INTO jobs
         (kind, payload, status, attempts, locked_at, locked_by)
       VALUES (
         'review',
         '{"githubRepoId":76001,"repoFullName":"successor/repo","prNumber":1,"headSha":"head"}'::jsonb,
         'running', 1, now(), 'release-e-worker'
       )
       RETURNING id, status, locked_by`,
    );
    expect(job.rows[0]).toMatchObject({
      status: "running",
      locked_by: "release-e-worker",
    });
    expect(await deferHostedReviewForRelease(
      pool,
      { id: Number(job.rows[0]!.id), lockedBy: "release-e-worker" },
      releaseE,
    )).toBe("deferred");
    await deactivateHostedInferenceRelease(pool, releaseF);
    expect(await activateHostedInferenceRelease(pool, releaseF)).toBe(true);
    const state = await pool.query<{
      status: string;
      staged: boolean;
      release_sha: string | null;
    }>(
      `SELECT status, run_after = 'infinity'::timestamptz AS staged,
              payload->>'releaseDarkSha' AS release_sha
         FROM jobs WHERE id = $1`,
      [job.rows[0]!.id],
    );
    expect(state.rows[0]).toEqual({
      status: "queued",
      staged: false,
      release_sha: null,
    });
  });

  test("backfills bounded hosted trials only for existing personal installations", async () => {
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    process.env.POSTIL_RELEASE_SHA = releaseC;
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.test";

    const personal = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('personal-backfill', 'Personal Backfill', 73001) RETURNING id
    `);
    const personalOrgId = Number(personal.rows[0]!.id);
    await pool.query(
      `
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74001, $1, 'personal-backfill', 'User', false)
    `,
      [personalOrgId],
    );
    await pool.query(
      `
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74003, $1, 'personal-backfill', 'User', false)
    `,
      [personalOrgId],
    );

    const unrecorded = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('unrecorded-personal-trial', 'Unrecorded Personal Trial', 73003)
      RETURNING id
    `);
    const unrecordedOrgId = Number(unrecorded.rows[0]!.id);
    await pool.query(
      `
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74004, $1, 'unrecorded-personal-trial', 'User', false)
    `,
      [unrecordedOrgId],
    );
    await pool.query(
      `
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, trial_ends_at, period_starts_at,
        period_ends_at, included_usage_micros, overage_hard_cap_micros,
        updated_by
      ) VALUES ($1, 'byok', 'trialing', now() + interval '30 days', now(),
                now() + interval '30 days', 100000000, 0, 'self-service-trial')
    `,
      [unrecordedOrgId],
    );

    const organization = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('organization-backfill', 'Organization Backfill', 73002) RETURNING id
    `);
    const organizationOrgId = Number(organization.rows[0]!.id);
    await pool.query(
      `
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74002, $1, 'organization-backfill', 'Organization', false)
    `,
      [organizationOrgId],
    );

    const organizationTrial = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('organization-trial-backfill', 'Organization Trial Backfill', 73004)
      RETURNING id
    `);
    const organizationTrialOrgId = Number(organizationTrial.rows[0]!.id);
    await pool.query(
      `
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74005, $1, 'organization-trial-backfill', 'Organization', false)
    `,
      [organizationTrialOrgId],
    );
    await pool.query(
      `
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, trial_ends_at, period_starts_at,
        period_ends_at, included_usage_micros, overage_hard_cap_micros,
        updated_by
      ) VALUES ($1, 'byok', 'trialing', now() + interval '30 days', now(),
                now() + interval '30 days', 100000000, 0, 'self-service-trial')
    `,
      [organizationTrialOrgId],
    );

    const configuredByok = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('configured-byok-trial', 'Configured BYOK Trial', 73005)
      RETURNING id
    `);
    const configuredByokOrgId = Number(configuredByok.rows[0]!.id);
    await pool.query(
      `
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74006, $1, 'configured-byok-trial', 'Organization', false)
    `,
      [configuredByokOrgId],
    );
    await pool.query(
      `
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, trial_ends_at, period_starts_at,
        period_ends_at, included_usage_micros, overage_hard_cap_micros,
        updated_by
      ) VALUES ($1, 'byok', 'trialing', now() + interval '30 days', now(),
                now() + interval '30 days', 100000000, 0, 'self-service-trial')
    `,
      [configuredByokOrgId],
    );
    await pool.query(
      `
      INSERT INTO org_settings (org_id, api_key_ciphertext)
      VALUES ($1, decode('01', 'hex'))
    `,
      [configuredByokOrgId],
    );

    const db = drizzle(pool, { schema });
    expect(
      await backfillSelfServiceTrials(db, {
        hostedInferenceEnabled: true,
        releaseSha: releaseC,
      }),
    ).toEqual({ eligible: 3, granted: 3 });
    expect(
      (
        await pool.query<{
          subscription_mode: string;
          requested_mode: string;
          granted_mode: string;
        }>(
          `
      SELECT entitlement.subscription_mode, trial.requested_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `,
          [personalOrgId],
        )
      ).rows[0],
    ).toEqual({
      subscription_mode: "byok",
      requested_mode: "hosted",
      granted_mode: "byok",
    });
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM organization_entitlements WHERE org_id = $1",
          [organizationOrgId],
        )
      ).rows[0]!.count,
    ).toBe("0");
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM operator_alert_deliveries WHERE org_id = $1 AND event = 'trial_started'",
          [personalOrgId],
        )
      ).rows[0]!.count,
    ).toBe("1");
    expect(
      (
        await pool.query<{ requested_mode: string; granted_mode: string }>(
          `
      SELECT requested_mode, granted_mode
      FROM self_service_trial_grants
      WHERE org_id = $1
    `,
          [unrecordedOrgId],
        )
      ).rows[0],
    ).toEqual({
      requested_mode: "hosted",
      granted_mode: "byok",
    });
    expect(
      (
        await pool.query<{ requested_mode: string; granted_mode: string }>(
          `
      SELECT requested_mode, granted_mode
      FROM self_service_trial_grants
      WHERE org_id = $1
    `,
          [organizationTrialOrgId],
        )
      ).rows[0],
    ).toEqual({
      requested_mode: "hosted",
      granted_mode: "byok",
    });
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM self_service_trial_grants WHERE org_id = $1",
          [configuredByokOrgId],
        )
      ).rows[0]!.count,
    ).toBe("0");
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM operator_alert_deliveries WHERE org_id = $1 AND event = 'trial_started'",
          [unrecordedOrgId],
        )
      ).rows[0]!.count,
    ).toBe("1");

    expect(await activateHostedInferenceRelease(pool, releaseC)).toBe(true);
    expect(
      (
        await pool.query<{ subscription_mode: string; granted_mode: string }>(
          `
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `,
          [personalOrgId],
        )
      ).rows[0],
    ).toEqual({
      subscription_mode: "hosted",
      granted_mode: "hosted",
    });
    expect(
      (
        await pool.query<{ subscription_mode: string; granted_mode: string }>(
          `
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `,
          [organizationTrialOrgId],
        )
      ).rows[0],
    ).toEqual({
      subscription_mode: "hosted",
      granted_mode: "hosted",
    });
    expect(
      (
        await pool.query<{ subscription_mode: string }>(
          "SELECT subscription_mode FROM organization_entitlements WHERE org_id = $1",
          [configuredByokOrgId],
        )
      ).rows[0]!.subscription_mode,
    ).toBe("byok");
    expect(
      (
        await pool.query<{ subscription_mode: string; granted_mode: string }>(
          `
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `,
          [unrecordedOrgId],
        )
      ).rows[0],
    ).toEqual({
      subscription_mode: "hosted",
      granted_mode: "hosted",
    });
    expect(
      await backfillSelfServiceTrials(db, {
        hostedInferenceEnabled: true,
        releaseSha: releaseC,
      }),
    ).toEqual({ eligible: 0, granted: 0 });
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM operator_alert_deliveries WHERE org_id = $1 AND event = 'trial_started'",
          [personalOrgId],
        )
      ).rows[0]!.count,
    ).toBe("1");
  });
});
