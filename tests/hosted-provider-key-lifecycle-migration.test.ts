import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("hosted provider key lifecycle migration", () => {
  const databaseName = `postil_hosted_provider_key_migration_v2_${process.pid}_${Date.now()}`;
  let admin: Client | undefined;
  let database: Client | undefined;
  let organizationId = "";
  let refreshSessionId = "";
  let refreshTokenId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);

    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    database = new Client({ connectionString: databaseUrl.toString() });
    await database.connect();

    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const previousMigrations = (await readdir(migrationDirectory))
      .filter((file) => /^\d{4}_.*[.]sql$/.test(file) && file < "0053_")
      .sort();
    for (const migration of previousMigrations) {
      await applyMigration(database, join(migrationDirectory, migration));
    }

    const fixture = await database.query<{
      organization_id: string;
      session_id: string;
      token_id: string;
    }>(
      `WITH inserted_user AS (
         INSERT INTO users (github_id, login)
         VALUES (99005301, 'provider-migration-user')
         RETURNING id
       ), inserted_org AS (
         INSERT INTO organizations (slug, name)
         VALUES ('provider-migration-org', 'Provider migration org')
         RETURNING id
       ), inserted_session AS (
         INSERT INTO cli_refresh_sessions
           (user_id, org_id, expires_at, last_used_at)
         SELECT inserted_user.id, inserted_org.id,
                clock_timestamp() + interval '30 days', clock_timestamp()
         FROM inserted_user, inserted_org
         RETURNING id, org_id
       ), inserted_token AS (
         INSERT INTO cli_refresh_tokens (token_sha256, session_id, expires_at)
         SELECT $1, inserted_session.id,
                clock_timestamp() + interval '30 days'
         FROM inserted_session
         RETURNING id, session_id
       )
       SELECT inserted_org.id::text AS organization_id,
              inserted_session.id::text AS session_id,
              inserted_token.id::text AS token_id
       FROM inserted_org, inserted_session, inserted_token`,
      [Buffer.alloc(32, 53)],
    );
    organizationId = fixture.rows[0]!.organization_id;
    refreshSessionId = fixture.rows[0]!.session_id;
    refreshTokenId = fixture.rows[0]!.token_id;
  }, 60_000);

  afterAll(async () => {
    await database?.end();
    if (admin) {
      if (process.env.POSTIL_KEEP_TEST_DATABASE === "1") {
        console.error(`Preserved test database ${databaseName}`);
      } else {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      }
      await admin.end();
    }
  }, 30_000);

  test("is absent at the current-main boundary and preserves renewable sessions", async () => {
    const before = await database!.query<{ relation: string | null }>(
      "SELECT to_regclass('public.hosted_provider_keys')::text AS relation",
    );
    expect(before.rows[0]!.relation).toBeNull();

    await applyMigration(
      database!,
      join(
        import.meta.dir,
        "..",
        "drizzle",
        "0053_wonderful_annihilus.sql",
      ),
    );

    const after = await database!.query<{
      relation: string;
      session_id: string;
      token_id: string;
      consumed_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT to_regclass('public.hosted_provider_keys')::text AS relation,
              s.id::text AS session_id, t.id::text AS token_id,
              t.consumed_at, s.revoked_at
       FROM cli_refresh_sessions s
       JOIN cli_refresh_tokens t ON t.session_id = s.id
       WHERE s.id = $1 AND t.id = $2`,
      [refreshSessionId, refreshTokenId],
    );
    expect(after.rows).toEqual([
      {
        relation: "hosted_provider_keys",
        session_id: refreshSessionId,
        token_id: refreshTokenId,
        consumed_at: null,
        revoked_at: null,
      },
    ]);
  });

  test("enforces exact limits, lifecycle shape, and partial hash ownership", async () => {
    const secondOrganization = await database!.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ('provider-migration-second', 'Provider migration second')
       RETURNING id`,
    );
    const thirdOrganization = await database!.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ('provider-migration-third', 'Provider migration third')
       RETURNING id`,
    );
    const periodStartsAt = new Date("2026-08-25T00:00:00.000Z");
    const periodEndsAt = new Date("2026-09-25T00:00:00.000Z");

    await database!.query(
      `INSERT INTO hosted_provider_keys
         (create_intent_id, org_id, state, provider_key_name, provider_key_hash,
          entitlement_period_starts_at, entitlement_period_ends_at,
          entitlement_updated_at, limit_micros, create_attempted_at,
          create_outcome, reconciliation_required_at)
       VALUES
         ('33333333-3333-4333-8333-333333333333', $1, 'activating',
          'migration-hash-owner', 'immutable-provider-hash', $2, $3,
          clock_timestamp(), 2251799813685247, clock_timestamp(), 'created',
          clock_timestamp())`,
      [organizationId, periodStartsAt, periodEndsAt],
    );
    await expect(
      database!.query(
        `INSERT INTO hosted_provider_keys
           (create_intent_id, org_id, state, provider_key_name,
            provider_key_hash, entitlement_period_starts_at,
            entitlement_period_ends_at, entitlement_updated_at, limit_micros,
            create_attempted_at, create_outcome, reconciliation_required_at)
         VALUES
           ('44444444-4444-4444-8444-444444444444', $1, 'activating',
            'migration-hash-conflict', 'immutable-provider-hash', $2, $3,
            clock_timestamp(), 1, clock_timestamp(), 'created',
            clock_timestamp())`,
        [secondOrganization.rows[0]!.id, periodStartsAt, periodEndsAt],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      database!.query(
        `INSERT INTO hosted_provider_keys
           (create_intent_id, org_id, state, provider_key_name,
            entitlement_period_starts_at, entitlement_period_ends_at,
            entitlement_updated_at, limit_micros)
         VALUES
           ('55555555-5555-4555-8555-555555555555', $1, 'provisioning',
            'migration-inexact-limit', $2, $3, clock_timestamp(),
            2251799813685248)`,
        [secondOrganization.rows[0]!.id, periodStartsAt, periodEndsAt],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      database!.query(
        `INSERT INTO hosted_provider_keys
           (create_intent_id, org_id, state, provider_key_name,
            entitlement_period_starts_at, entitlement_period_ends_at,
            entitlement_updated_at, limit_micros)
         VALUES
           ('66666666-6666-4666-8666-666666666666', $1, 'provisioning',
            'migration-null-hash-a', $2, $3, clock_timestamp(), 1),
           ('77777777-7777-4777-8777-777777777777', $4, 'provisioning',
            'migration-null-hash-b', $2, $3, clock_timestamp(), 1)`,
        [
          secondOrganization.rows[0]!.id,
          periodStartsAt,
          periodEndsAt,
          thirdOrganization.rows[0]!.id,
        ],
      ),
    ).resolves.toBeDefined();

    await expect(
      database!.query(
        `INSERT INTO hosted_provider_keys
           (create_intent_id, org_id, state, provider_key_name,
            entitlement_period_starts_at, entitlement_period_ends_at,
            entitlement_updated_at, limit_micros, sealed_runtime_key)
         VALUES
           ('88888888-8888-4888-8888-888888888888', $1, 'provisioning',
            'migration-invalid-credential-shape', $2, $3,
            clock_timestamp(), 1, $4)`,
        [
          thirdOrganization.rows[0]!.id,
          new Date("2026-10-01T00:00:00.000Z"),
          new Date("2026-11-01T00:00:00.000Z"),
          Buffer.from("must-not-be-accepted"),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

async function applyMigration(client: Client, path: string): Promise<void> {
  const source = await readFile(path, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}
