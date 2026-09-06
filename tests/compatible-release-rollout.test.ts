import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import { checkedInReleaseMigrations } from "../scripts/run-release-migrations";
import {
  COMPATIBLE_MANAGED_RELEASE_BOOTSTRAP_SHAS,
  COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
  HOSTED_INFERENCE_LOCK,
  PRIVATE_REVIEW_AUTHOR_CAPABILITY,
  RELEASE_V1_JOBS_CAPABILITY,
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
      await migration.query("CREATE SCHEMA drizzle");
      await migration.query(`CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`);
      for (const identity of migrations) {
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
      await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin?.end();
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
