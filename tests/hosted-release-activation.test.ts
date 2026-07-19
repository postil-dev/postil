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
  hostedInferenceReleaseActivated,
} from "@/lib/release-job-rollout";
import { backfillExistingPersonalAccountTrials } from "@/lib/self-service-trial";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("managed hosted inference release activation", () => {
  const databaseName = `postil_hosted_activation_${process.pid}_${Date.now()}`;
  const releaseA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const releaseB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const releaseC = "cccccccccccccccccccccccccccccccccccccccc";
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
      const source = await readFile(join(import.meta.dir, "..", "drizzle", file), "utf8");
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
    await pool.query(`
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, trial_ends_at, period_starts_at,
        period_ends_at, included_usage_micros, overage_hard_cap_micros,
        updated_by
      ) VALUES ($1, 'byok', 'trialing', now() + interval '30 days', now(),
                now() + interval '30 days', 100000000, 0, 'self-service-trial')
    `, [darkTrialOrgId]);
    await pool.query(`
      INSERT INTO self_service_trial_grants (
        org_id, initiated_by_github_id, requested_mode, granted_mode
      ) VALUES ($1, 72001, 'hosted', 'byok')
    `, [darkTrialOrgId]);
    const manualTrial = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('manual-byok-trial', 'Manual BYOK Trial', 71002) RETURNING id
    `);
    const manualTrialOrgId = Number(manualTrial.rows[0]!.id);
    await pool.query(`
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, trial_ends_at, period_starts_at,
        period_ends_at, included_usage_micros, overage_hard_cap_micros,
        updated_by
      ) VALUES ($1, 'byok', 'trialing', now() + interval '30 days', now(),
                now() + interval '30 days', 100000000, 0, 'trial-provider-mode')
    `, [manualTrialOrgId]);
    await pool.query(`
      INSERT INTO self_service_trial_grants (
        org_id, initiated_by_github_id, requested_mode, granted_mode
      ) VALUES ($1, 72002, 'hosted', 'byok')
    `, [manualTrialOrgId]);

    await expect(activateHostedInferenceRelease(pool, "invalid release"))
      .rejects.toThrow("requires a release SHA");
    expect((await pool.query<{ subscription_mode: string }>(
      "SELECT subscription_mode FROM organization_entitlements WHERE org_id = $1",
      [darkTrialOrgId],
    )).rows[0]!.subscription_mode).toBe("byok");

    expect(await activateHostedInferenceRelease(pool, releaseA)).toBe(true);
    expect(await hostedInferenceAvailable(pool)).toBe(true);
    expect((await pool.query<{ subscription_mode: string; granted_mode: string }>(`
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `, [darkTrialOrgId])).rows[0]).toEqual({
      subscription_mode: "hosted",
      granted_mode: "hosted",
    });
    expect((await pool.query<{ subscription_mode: string; granted_mode: string }>(`
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `, [manualTrialOrgId])).rows[0]).toEqual({
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

  test("backfills bounded hosted trials only for existing personal installations", async () => {
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    process.env.POSTIL_RELEASE_SHA = releaseC;
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.test";

    const personal = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('personal-backfill', 'Personal Backfill', 73001) RETURNING id
    `);
    const personalOrgId = Number(personal.rows[0]!.id);
    await pool.query(`
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74001, $1, 'personal-backfill', 'User', false)
    `, [personalOrgId]);
    await pool.query(`
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74003, $1, 'personal-backfill', 'User', false)
    `, [personalOrgId]);

    const unrecorded = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('unrecorded-personal-trial', 'Unrecorded Personal Trial', 73003)
      RETURNING id
    `);
    const unrecordedOrgId = Number(unrecorded.rows[0]!.id);
    await pool.query(`
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74004, $1, 'unrecorded-personal-trial', 'User', false)
    `, [unrecordedOrgId]);
    await pool.query(`
      INSERT INTO organization_entitlements (
        org_id, subscription_mode, status, trial_ends_at, period_starts_at,
        period_ends_at, included_usage_micros, overage_hard_cap_micros,
        updated_by
      ) VALUES ($1, 'byok', 'trialing', now() + interval '30 days', now(),
                now() + interval '30 days', 100000000, 0, 'self-service-trial')
    `, [unrecordedOrgId]);

    const organization = await pool.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, github_org_id)
      VALUES ('organization-backfill', 'Organization Backfill', 73002) RETURNING id
    `);
    const organizationOrgId = Number(organization.rows[0]!.id);
    await pool.query(`
      INSERT INTO installations (
        github_installation_id, org_id, account_login, account_type, suspended
      ) VALUES (74002, $1, 'organization-backfill', 'Organization', false)
    `, [organizationOrgId]);

    const db = drizzle(pool, { schema });
    expect(await backfillExistingPersonalAccountTrials(db, {
      hostedInferenceEnabled: true,
      releaseSha: releaseC,
    })).toEqual({ eligible: 2, granted: 2 });
    expect((await pool.query<{ subscription_mode: string; requested_mode: string; granted_mode: string }>(`
      SELECT entitlement.subscription_mode, trial.requested_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `, [personalOrgId])).rows[0]).toEqual({
      subscription_mode: "byok",
      requested_mode: "hosted",
      granted_mode: "byok",
    });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*) FROM organization_entitlements WHERE org_id = $1",
      [organizationOrgId],
    )).rows[0]!.count).toBe("0");
    expect((await pool.query<{ count: string }>(
      "SELECT count(*) FROM operator_alert_deliveries WHERE org_id = $1 AND event = 'trial_started'",
      [personalOrgId],
    )).rows[0]!.count).toBe("1");
    expect((await pool.query<{ requested_mode: string; granted_mode: string }>(`
      SELECT requested_mode, granted_mode
      FROM self_service_trial_grants
      WHERE org_id = $1
    `, [unrecordedOrgId])).rows[0]).toEqual({
      requested_mode: "hosted",
      granted_mode: "byok",
    });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*) FROM operator_alert_deliveries WHERE org_id = $1 AND event = 'trial_started'",
      [unrecordedOrgId],
    )).rows[0]!.count).toBe("1");

    expect(await activateHostedInferenceRelease(pool, releaseC)).toBe(true);
    expect((await pool.query<{ subscription_mode: string; granted_mode: string }>(`
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `, [personalOrgId])).rows[0]).toEqual({
      subscription_mode: "hosted",
      granted_mode: "hosted",
    });
    expect((await pool.query<{ subscription_mode: string; granted_mode: string }>(`
      SELECT entitlement.subscription_mode, trial.granted_mode
      FROM organization_entitlements entitlement
      JOIN self_service_trial_grants trial ON trial.org_id = entitlement.org_id
      WHERE entitlement.org_id = $1
    `, [unrecordedOrgId])).rows[0]).toEqual({
      subscription_mode: "hosted",
      granted_mode: "hosted",
    });
    expect(await backfillExistingPersonalAccountTrials(db, {
      hostedInferenceEnabled: true,
      releaseSha: releaseC,
    })).toEqual({ eligible: 0, granted: 0 });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*) FROM operator_alert_deliveries WHERE org_id = $1 AND event = 'trial_started'",
      [personalOrgId],
    )).rows[0]!.count).toBe("1");
  });
});
