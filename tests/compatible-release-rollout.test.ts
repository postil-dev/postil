import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import { checkedInReleaseMigrations, runReleaseMigrations } from "../scripts/run-release-migrations";
import {
  COMPATIBLE_MANAGED_RELEASE_BOOTSTRAP_SHAS,
  COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
  HOSTED_INFERENCE_LOCK,
  PRIVATE_REVIEW_AUTHOR_CAPABILITY,
  RELEASE_V1_JOBS_CAPABILITY,
  applyReviewedFeedbackControlMigration,
  applyReviewedMonitoringDeliveryMigration,
  compatibleManagedReleaseProtocolCapability,
  hostedInferenceCapability,
  prepareCompatibleManagedRelease,
  verifyCompatibleManagedRelease,
  verifyPreparedCompatibleManagedRelease,
  withHostedInferenceReleaseActive,
} from "@/lib/release-job-rollout";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDatabase = TEST_URL ? describe : describe.skip;

describe("compatible managed release identity", () => {
  test("rejects malformed full migration lists before opening any database transaction", async () => {
    const migrations = checkedInReleaseMigrations();
    const latest = migrations.at(-1)!;
    const source = await readFile(join(import.meta.dir, "..", "drizzle", "0063_review_feedback_control.sql"), "utf8");
    let connected = false;
    const pool = { connect() { connected = true; throw new Error("database must not be contacted"); } } as unknown as Pool;
    for (const dryRun of [true, false]) {
      for (const identities of [
        [...migrations, latest],
        [...migrations, { folderMillis: latest.folderMillis + 1, hash: "invalid" }],
        [...migrations, { folderMillis: -1, hash: latest.hash }],
        [...migrations, { folderMillis: Number.MAX_SAFE_INTEGER + 1, hash: latest.hash }],
      ]) {
        await expect(applyReviewedFeedbackControlMigration(pool, "a".repeat(40), "b".repeat(40),
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL, identities, source, { dryRun })).rejects.toThrow("identities are invalid");
      }
    }
    expect(connected).toBe(false);
  });

  test("requires exact lowercase 40-character release SHAs", () => {
    expect(
      compatibleManagedReleaseProtocolCapability("a".repeat(40)),
    ).toBe(
      `managed-release-protocol:${"a".repeat(40)}:${COMPATIBLE_MANAGED_RELEASE_PROTOCOL}`,
    );
    for (const releaseSha of [
      "a".repeat(7),
      "A".repeat(40),
      ` ${"a".repeat(40)}`,
      `${"a".repeat(40)} `,
      "g".repeat(40),
    ]) {
      expect(() =>
        compatibleManagedReleaseProtocolCapability(releaseSha),
      ).toThrow("exact lowercase release SHA");
    }
  });
});

describeDatabase("managed release upgrade from monitoring migration 0061", () => {
  const databaseName = `postil_release_upgrade_${process.pid}_${Date.now()}`;
  const cleanDatabaseName = `${databaseName}_clean`;
  const sourceRelease = COMPATIBLE_MANAGED_RELEASE_BOOTSTRAP_SHAS[0]!;
  const targetRelease = "a".repeat(40);
  const migrations = checkedInReleaseMigrations();
  const monitoring = migrations.at(-2)!;
  const feedback = migrations.at(-1)!;
  let admin: Client;
  let pool: Pool;
  let cleanPool: Pool;
  let environment: Record<string, string>;
  let cleanEnvironment: Record<string, string>;

  beforeAll(async () => {
    admin = new Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(TEST_URL!);
    url.pathname = `/${databaseName}`;
    const migration = new Client({ connectionString: url.toString() });
    await migration.connect();
    for (const file of (await readdir(join(import.meta.dir, "..", "drizzle")))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name) && !/^006[23]_/.test(name))
      .sort()) {
      const source = await readFile(join(import.meta.dir, "..", "drizzle", file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migration.query(statement);
      }
    }
    await migration.query("CREATE SCHEMA drizzle");
    await migration.query(`CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`);
    for (const identity of migrations.slice(0, -2)) {
      await migration.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [identity.hash, identity.folderMillis],
      );
    }
    await migration.end();
    await admin.query(`CREATE DATABASE "${cleanDatabaseName}" TEMPLATE "${databaseName}"`);
    pool = new Pool({ connectionString: url.toString() });
    const cleanUrl = new URL(TEST_URL!);
    cleanUrl.pathname = `/${cleanDatabaseName}`;
    cleanPool = new Pool({ connectionString: cleanUrl.toString() });
    for (const database of [pool, cleanPool]) await database.query(
      `INSERT INTO deployment_capabilities (name)
       SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`, [[
        "publication-lifecycle-fleet-active",
        "hosted-inference-fleet-active",
        RELEASE_V1_JOBS_CAPABILITY,
        PRIVATE_REVIEW_AUTHOR_CAPABILITY,
        hostedInferenceCapability(sourceRelease),
      ]],
    );
    environment = {
      DATABASE_URL: url.toString(),
      POSTIL_MANAGED_RELEASE: "1",
      POSTIL_RELEASE_SHA: targetRelease,
      POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA: sourceRelease,
      POSTIL_RELEASE_PROTOCOL: COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
    };
    cleanEnvironment = { ...environment, DATABASE_URL: cleanUrl.toString() };
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await cleanPool?.end();
    if (process.env.POSTIL_KEEP_TEST_DATABASE === "1") {
      console.error(`Preserved test database ${databaseName}`);
      console.error(`Preserved test database ${cleanDatabaseName}`);
    } else {
      await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin?.query(`DROP DATABASE IF EXISTS "${cleanDatabaseName}"`);
    }
    await admin?.end();
  }, 30_000);

  test("rolls back a failed 0062, then applies 0062 and 0063 once in order", async () => {
    const commands: string[][] = [];
    const release = () => runReleaseMigrations(environment,
      (command) => { commands.push([...command]); return { exited: Promise.resolve(0) }; },
      undefined, async () => true);
    const journal = async () => (await pool.query<{ created_at: string; hash: string }>(
      "SELECT created_at::text, hash FROM drizzle.__drizzle_migrations WHERE created_at >= $1 ORDER BY created_at",
      [monitoring.folderMillis],
    )).rows;

    const feedbackSource = await readFile(join(import.meta.dir, "..", "drizzle", "0063_review_feedback_control.sql"), "utf8");
    await expect(applyReviewedFeedbackControlMigration(pool, sourceRelease, targetRelease,
      COMPATIBLE_MANAGED_RELEASE_PROTOCOL, migrations, feedbackSource))
      .rejects.toThrow("pending migrations");
    expect(await journal()).toEqual([]);
    const monitoringSource = await readFile(join(import.meta.dir, "..", "drizzle", "0062_monitor_delivery_receipt.sql"), "utf8");
    await expect(applyReviewedMonitoringDeliveryMigration(pool, sourceRelease, targetRelease,
      COMPATIBLE_MANAGED_RELEASE_PROTOCOL, migrations.slice(0, -1), monitoringSource + "\n"))
      .rejects.toThrow("reviewed identity");
    expect(await journal()).toEqual([]);

    await pool.query(`CREATE FUNCTION reject_monitor_journal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.created_at = ${monitoring.folderMillis} THEN RAISE EXCEPTION 'injected 0062 journal failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_monitor_journal_insert BEFORE INSERT ON drizzle.__drizzle_migrations
      FOR EACH ROW EXECUTE FUNCTION reject_monitor_journal_insert()`);
    await expect(release()).rejects.toThrow("injected 0062 journal failure");
    expect(await journal()).toEqual([]);
    expect((await pool.query("SELECT to_regclass('public.review_feedback_control') AS relation")).rows[0].relation).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='private_monitor_incidents' AND column_name='last_delivery_receipt'")).rows).toEqual([]);
    expect(commands).toEqual([]);
    await pool.query("ALTER TABLE drizzle.__drizzle_migrations DISABLE TRIGGER reject_monitor_journal_insert");

    await pool.query(`CREATE FUNCTION reject_feedback_journal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.created_at = ${feedback.folderMillis} THEN RAISE EXCEPTION 'injected 0063 journal failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_feedback_journal_insert BEFORE INSERT ON drizzle.__drizzle_migrations
      FOR EACH ROW EXECUTE FUNCTION reject_feedback_journal_insert()`);
    await expect(release()).rejects.toThrow("injected 0063 journal failure");
    expect(await journal()).toEqual([
      { created_at: String(monitoring.folderMillis), hash: monitoring.hash },
    ]);
    expect((await pool.query("SELECT to_regclass('public.review_feedback_control') AS relation")).rows[0].relation).toBeNull();
    expect(commands).toEqual([]);
    await pool.query("ALTER TABLE drizzle.__drizzle_migrations DISABLE TRIGGER reject_feedback_journal_insert");

    await release();
    expect(await journal()).toEqual([
      { created_at: String(monitoring.folderMillis), hash: monitoring.hash },
      { created_at: String(feedback.folderMillis), hash: feedback.hash },
    ]);
    expect((await pool.query("SELECT id, mode FROM review_feedback_control")).rows)
      .toEqual([{ id: 1, mode: "disabled" }]);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='private_monitor_incidents' AND column_name='last_delivery_receipt'")).rows)
      .toEqual([{ column_name: "last_delivery_receipt" }]);
    await withHostedInferenceReleaseActive(pool, sourceRelease, async () => {
      const inserted = await pool.query(
        "INSERT INTO jobs(kind,payload) VALUES('review',$1::jsonb) RETURNING status",
        [JSON.stringify({ githubRepoId: 123, repoFullName: "fixture/repository", prNumber: 63, headSha: "d".repeat(40) })],
      );
      expect(inserted.rows).toEqual([{ status: "queued" }]);
    });
    await release();
    expect(await journal()).toHaveLength(2);
    expect(commands).toEqual([
      ["bun", "run", "hosted:verify-provider"],
      ["bun", "run", "hosted:verify-provider"],
    ]);
  }, 30_000);

  test("upgrades directly from 0061 and leaves a rerun unchanged", async () => {
    const release = () => runReleaseMigrations(cleanEnvironment,
      () => ({ exited: Promise.resolve(0) }), undefined, async () => true);
    await release();
    const journal = async () => (await cleanPool.query<{ created_at: string; hash: string }>(
      "SELECT created_at::text, hash FROM drizzle.__drizzle_migrations WHERE created_at >= $1 ORDER BY created_at",
      [monitoring.folderMillis],
    )).rows;
    const expected = [
      { created_at: String(monitoring.folderMillis), hash: monitoring.hash },
      { created_at: String(feedback.folderMillis), hash: feedback.hash },
    ];
    expect(await journal()).toEqual(expected);
    await release();
    expect(await journal()).toEqual(expected);
    expect((await cleanPool.query("SELECT id, mode FROM review_feedback_control")).rows)
      .toEqual([{ id: 1, mode: "disabled" }]);
  }, 30_000);
});

for (const sourceRelease of COMPATIBLE_MANAGED_RELEASE_BOOTSTRAP_SHAS) {
  describeDatabase(`compatible managed release rollout from ${sourceRelease}`, () => {
    const databaseName = `postil_compatible_release_${sourceRelease.slice(0, 8)}_${process.pid}_${Date.now()}`;
    const targetRelease = "a".repeat(40);
    const successorRelease = "b".repeat(40);
    const rejectedRelease = "c".repeat(40);
    const migrations = checkedInReleaseMigrations();
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
        .filter((name) => /^\d{4}_.*\.sql$/.test(name) && !name.startsWith("0063_"))
        .sort()) {
        const source = await readFile(
          join(import.meta.dir, "..", "drizzle", file),
          "utf8",
        );
        for (const statement of source.split("--> statement-breakpoint")) {
          if (statement.trim()) await migration.query(statement);
        }
      }
      await migration.query("CREATE SCHEMA drizzle");
      await migration.query(`CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`);
      for (const identity of migrations.slice(0, -1)) {
        await migration.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ($1, $2)`,
          [identity.hash, identity.folderMillis],
        );
      }
      await migration.end();
      pool = new Pool({ connectionString: url.toString(), max: 4 });
      await pool.query(
        `INSERT INTO deployment_capabilities (name)
         SELECT unnest($1::text[])
         ON CONFLICT (name) DO NOTHING`,
        [[
          "publication-lifecycle-fleet-active",
          "hosted-inference-fleet-active",
          RELEASE_V1_JOBS_CAPABILITY,
          PRIVATE_REVIEW_AUTHOR_CAPABILITY,
          hostedInferenceCapability(sourceRelease),
        ]],
      );
    }, 30_000);

    afterAll(async () => {
      await pool?.end();
      if (process.env.POSTIL_KEEP_TEST_DATABASE === "1") {
        console.error(`Preserved test database ${databaseName}`);
      } else {
        await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      }
      await admin?.end();
    }, 30_000);

    test("applies only the reviewed additive migration atomically without retiring the source", async () => {
      const source = await readFile(join(import.meta.dir, "..", "drizzle", "0063_review_feedback_control.sql"), "utf8");
      const latest = migrations.at(-1)!;
      const previous = migrations.at(-2)!;
      const capabilities = async () => (await pool.query("SELECT name FROM deployment_capabilities ORDER BY name")).rows;
      const before = await capabilities();
      const apply = (dryRun = false, identities = migrations, sql = source) =>
        applyReviewedFeedbackControlMigration(pool, sourceRelease, targetRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL, identities, sql, { dryRun });
      const unchanged = async () => {
        expect((await pool.query("SELECT to_regclass('public.review_feedback_control') AS relation")).rows[0].relation).toBeNull();
        expect((await pool.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE created_at=$1", [latest.folderMillis])).rows[0].count).toBe(0);
        expect(await capabilities()).toEqual(before);
      };
      await expect(verifyCompatibleManagedRelease(pool, sourceRelease, targetRelease,
        COMPATIBLE_MANAGED_RELEASE_PROTOCOL, migrations)).rejects.toThrow("pending migrations");
      expect(await apply(true)).toBe(true);
      await unchanged();
      await expect(apply(false, migrations, source + "\n")).rejects.toThrow("reviewed identity");
      await expect(apply(true, [...migrations, latest])).rejects.toThrow("identities are invalid");
      await expect(apply(false, [...migrations, { folderMillis: latest.folderMillis + 1, hash: "a".repeat(64) }])).rejects.toThrow("unapproved pending");
      await unchanged();

      const unknown = await pool.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2) RETURNING id", ["a".repeat(64), latest.folderMillis + 1]);
      try { await expect(apply()).rejects.toThrow("unknown migrations"); }
      finally { await pool.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=$1", [unknown.rows[0].id]); }
      await pool.query("UPDATE drizzle.__drizzle_migrations SET hash=$1 WHERE created_at=$2", ["b".repeat(64), previous.folderMillis]);
      try { await expect(apply()).rejects.toThrow("journal mismatch"); }
      finally { await pool.query("UPDATE drizzle.__drizzle_migrations SET hash=$1 WHERE created_at=$2", [previous.hash, previous.folderMillis]); }
      await pool.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at=$1", [previous.folderMillis]);
      try { await expect(apply()).rejects.toThrow("pending migrations"); }
      finally { await pool.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [previous.hash, previous.folderMillis]); }
      await pool.query("DELETE FROM deployment_capabilities WHERE name=$1", [hostedInferenceCapability(sourceRelease)]);
      try { await expect(apply()).rejects.toThrow("active hosted release capability"); }
      finally { await pool.query("INSERT INTO deployment_capabilities(name) VALUES($1)", [hostedInferenceCapability(sourceRelease)]); }
      await unchanged();

      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE");
        await expect(apply()).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      await unchanged();

      await pool.query(`CREATE FUNCTION reject_reviewed_journal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.created_at = ${latest.folderMillis} THEN RAISE EXCEPTION 'injected journal insertion failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_reviewed_journal_insert BEFORE INSERT ON drizzle.__drizzle_migrations
        FOR EACH ROW EXECUTE FUNCTION reject_reviewed_journal_insert()`);
      await expect(apply()).rejects.toThrow("injected journal insertion failure");
      await unchanged();
      await pool.query("ALTER TABLE drizzle.__drizzle_migrations DISABLE TRIGGER reject_reviewed_journal_insert");

      const oldWriter = async (prNumber: number) => withHostedInferenceReleaseActive(pool, sourceRelease, async () => {
        const result = await pool.query("INSERT INTO jobs(kind,payload) VALUES('review',$1::jsonb) RETURNING kind,status", [JSON.stringify({ githubRepoId: 123, repoFullName: "fixture/repository", prNumber, headSha: "d".repeat(40) })]);
        expect(result.rows).toEqual([{ kind: "review", status: "queued" }]);
      });
      await oldWriter(1);
      const older = migrations[7]!;
      await pool.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at=$1", [older.folderMillis]);
      try {
        const commands: string[][] = [];
        const url = new URL(TEST_URL!); url.pathname = `/${databaseName}`;
        await runReleaseMigrations({ DATABASE_URL: url.toString(), POSTIL_MANAGED_RELEASE: "1",
          POSTIL_RELEASE_SHA: targetRelease, POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA: sourceRelease,
          POSTIL_RELEASE_PROTOCOL: COMPATIBLE_MANAGED_RELEASE_PROTOCOL },
          (command) => { commands.push([...command]); return { exited: Promise.resolve(0) }; },
          undefined, async () => true);
        expect(commands).toEqual([["bun", "run", "hosted:verify-provider"]]);
        expect(await apply()).toBe(false);
        expect(await apply(true)).toBe(false);
        expect(await capabilities()).toEqual(before);
        expect((await pool.query("SELECT id, mode FROM review_feedback_control")).rows).toEqual([{ id: 1, mode: "disabled" }]);
        expect((await pool.query("SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=$1", [latest.folderMillis])).rows).toEqual([{ hash: latest.hash }]);
        await oldWriter(2);
        await pool.query(`INSERT INTO private_monitor_incidents
          (key, "group", severity, summary, detail, first_detected_at, last_detected_at,
           pending_notification_key, pending_notification_kind)
          VALUES ('legacy-monitor', 'monitoring', 'warning', 'Fixture', 'Fixture', now(), now(), 'legacy-request', 'opened')`);
        // The deployed monitor reads and acknowledges only its existing columns.
        expect((await pool.query("SELECT pending_notification_key FROM private_monitor_incidents WHERE key='legacy-monitor'")).rows)
          .toEqual([{ pending_notification_key: 'legacy-request' }]);
        await pool.query(`UPDATE private_monitor_incidents SET last_notified_at=now(),
          pending_notification_key=NULL, pending_notification_kind=NULL WHERE key='legacy-monitor'`);
        expect((await pool.query("SELECT last_delivery_receipt, last_notification_key FROM private_monitor_incidents WHERE key='legacy-monitor'")).rows)
          .toEqual([{ last_delivery_receipt: null, last_notification_key: null }]);
      } finally {
        await pool.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [older.hash, older.folderMillis]);
      }
    }, 30_000);

    test("rejects a rerun unless the applied feedback control remains disabled", async () => {
      const url = new URL(TEST_URL!);
      url.pathname = `/${databaseName}`;
      const environment = {
        DATABASE_URL: url.toString(),
        POSTIL_MANAGED_RELEASE: "1",
        POSTIL_RELEASE_SHA: targetRelease,
        POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA: sourceRelease,
        POSTIL_RELEASE_PROTOCOL: COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
      };
      const commands: string[][] = [];
      try {
        for (const mode of ["enabled", "inherit"]) {
          await pool.query("UPDATE review_feedback_control SET mode = $1 WHERE id = 1", [mode]);
          await expect(runReleaseMigrations(environment,
            (command) => { commands.push([...command]); return { exited: Promise.resolve(0) }; },
            undefined,
            async () => false,
          )).rejects.toThrow("feedback control must be disabled");
        }
        expect(commands).toEqual([]);
      } finally {
        await pool.query("UPDATE review_feedback_control SET mode = 'disabled' WHERE id = 1");
      }
    }, 30_000);

    test("bootstraps the reviewed protocol and authorizes old and new releases together", async () => {
      await verifyCompatibleManagedRelease(
        pool,
        sourceRelease,
        targetRelease,
        COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
        migrations,
      );
      expect(
        await prepareCompatibleManagedRelease(
          pool,
          sourceRelease,
          targetRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
          migrations,
        ),
      ).toBe(true);
      await verifyPreparedCompatibleManagedRelease(
        pool,
        sourceRelease,
        targetRelease,
        COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
        migrations,
      );

      const names = await pool.query<{ name: string }>(
        `SELECT name FROM deployment_capabilities
          WHERE name LIKE 'managed-release-protocol:%'
             OR name = ANY($1::text[])
          ORDER BY name`,
        [[hostedInferenceCapability(sourceRelease), hostedInferenceCapability(targetRelease)]],
      );
      expect(names.rows.map((row) => row.name)).toEqual([
        hostedInferenceCapability(targetRelease),
        hostedInferenceCapability(sourceRelease),
        compatibleManagedReleaseProtocolCapability(targetRelease),
        compatibleManagedReleaseProtocolCapability(sourceRelease),
      ].sort());

      const operations: string[] = [];
      await Promise.all([
        withHostedInferenceReleaseActive(pool, sourceRelease, async () => {
          operations.push("source");
        }),
        withHostedInferenceReleaseActive(pool, targetRelease, async () => {
          operations.push("target");
        }),
      ]);
      expect(operations.sort()).toEqual(["source", "target"]);

      expect(
        await prepareCompatibleManagedRelease(
          pool,
          targetRelease,
          successorRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
          migrations,
        ),
      ).toBe(true);
      await verifyPreparedCompatibleManagedRelease(
        pool,
        targetRelease,
        successorRelease,
        COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
        migrations,
      );
    });

    test("accepts an older journal gap when the checked-in watermark is applied", async () => {
      const older = migrations[7]!;
      await pool.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [older.folderMillis],
      );
      try {
        await verifyCompatibleManagedRelease(
          pool,
          successorRelease,
          rejectedRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
          migrations,
        );
        expect(await capabilityPresent(rejectedRelease)).toBe(false);
      } finally {
        await pool.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
          [older.hash, older.folderMillis],
        );
      }
    });

    test("rejects duplicate and malformed journal rows without granting the release", async () => {
      const migration = migrations[0]!;
      for (const row of [
        { hash: migration.hash, createdAt: migration.folderMillis },
        { hash: migration.hash, createdAt: null },
        { hash: "invalid-hash", createdAt: migration.folderMillis + 1 },
      ]) {
        const inserted = await pool.query<{ id: number }>(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ($1, $2) RETURNING id`,
          [row.hash, row.createdAt],
        );
        try {
          await expect(
            prepareCompatibleManagedRelease(
              pool,
              successorRelease,
              rejectedRelease,
              COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
              migrations,
            ),
          ).rejects.toThrow("unknown migrations");
          expect(await capabilityPresent(rejectedRelease)).toBe(false);
        } finally {
          await pool.query(
            `DELETE FROM drizzle.__drizzle_migrations WHERE id = $1`,
            [inserted.rows[0]!.id],
          );
        }
      }
    });

    test("rejects pending, unknown, mismatched, and incompatible state without granting the release", async () => {
      const last = migrations.at(-1)!;
      await pool.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [last.folderMillis],
      );
      await expect(
        prepareCompatibleManagedRelease(
          pool,
          successorRelease,
          rejectedRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
          migrations,
        ),
      ).rejects.toThrow("pending migrations");
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [last.hash, last.folderMillis],
      );
      expect(await capabilityPresent(rejectedRelease)).toBe(false);

      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        ["f".repeat(64), last.folderMillis + 1],
      );
      await expect(
        prepareCompatibleManagedRelease(
          pool,
          successorRelease,
          rejectedRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
          migrations,
        ),
      ).rejects.toThrow("unknown migrations");
      await pool.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [last.folderMillis + 1],
      );
      expect(await capabilityPresent(rejectedRelease)).toBe(false);

      await pool.query(
        `UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE created_at = $2`,
        ["0".repeat(64), last.folderMillis],
      );
      await expect(
        prepareCompatibleManagedRelease(
          pool,
          successorRelease,
          rejectedRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
          migrations,
        ),
      ).rejects.toThrow("migration journal mismatch");
      await pool.query(
        `UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE created_at = $2`,
        [last.hash, last.folderMillis],
      );
      expect(await capabilityPresent(rejectedRelease)).toBe(false);

      await pool.query(
        `INSERT INTO deployment_capabilities (name)
         VALUES ($1)`,
        [
          `managed-release-protocol:${"d".repeat(7)}:${COMPATIBLE_MANAGED_RELEASE_PROTOCOL}`,
        ],
      );
      await expect(
        prepareCompatibleManagedRelease(
          pool,
          successorRelease,
          rejectedRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
          migrations,
        ),
      ).rejects.toThrow("incompatible protocol capability");
      expect(await capabilityPresent(rejectedRelease)).toBe(false);
      await pool.query(
        `DELETE FROM deployment_capabilities
          WHERE name = $1`,
        [
          `managed-release-protocol:${"d".repeat(7)}:${COMPATIBLE_MANAGED_RELEASE_PROTOCOL}`,
        ],
      );
    });

    test("fails immediately on lifecycle lock contention without granting the release", async () => {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [HOSTED_INFERENCE_LOCK],
        );
        await expect(
          prepareCompatibleManagedRelease(
            pool,
            successorRelease,
            rejectedRelease,
            COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
            migrations,
          ),
        ).rejects.toThrow("hosted lifecycle lock is busy");
        expect(await capabilityPresent(rejectedRelease)).toBe(false);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });

    test("requires every active baseline capability without granting the release", async () => {
      await pool.query("DELETE FROM deployment_capabilities WHERE name = $1", [
        PRIVATE_REVIEW_AUTHOR_CAPABILITY,
      ]);
      await expect(
        prepareCompatibleManagedRelease(
          pool,
          successorRelease,
          rejectedRelease,
          COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
          migrations,
        ),
      ).rejects.toThrow("every active baseline capability");
      expect(await capabilityPresent(rejectedRelease)).toBe(false);
      await pool.query(
        `INSERT INTO deployment_capabilities (name) VALUES ($1)`,
        [PRIVATE_REVIEW_AUTHOR_CAPABILITY],
      );
    });

    async function capabilityPresent(releaseSha: string): Promise<boolean> {
      const result = await pool.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM deployment_capabilities WHERE name = $1
         ) AS present`,
        [hostedInferenceCapability(releaseSha)],
      );
      return result.rows[0]?.present === true;
    }
  });

}
