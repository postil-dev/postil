import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";

import { getTableConfig } from "drizzle-orm/pg-core";

import { hostedProviderKeys } from "@/lib/db/schema";
import providerKeySnapshot from "../drizzle/meta/0053_snapshot.json";

describe("hosted provider key lifecycle schema", () => {
  test("stores exact period bindings and leased create and revoke state", () => {
    const config = getTableConfig(hostedProviderKeys);
    const columns = Object.fromEntries(
      config.columns.map((column) => [
        column.name,
        { notNull: column.notNull, type: column.getSQLType() },
      ]),
    );

    expect(config.name).toBe("hosted_provider_keys");
    expect(columns).toMatchObject({
      create_intent_id: { notNull: true, type: "uuid" },
      org_id: { notNull: true, type: "bigint" },
      provider_key_name: { notNull: true, type: "text" },
      provider_key_hash: { notNull: false, type: "text" },
      sealed_runtime_key: { notNull: false, type: "bytea" },
      entitlement_period_starts_at: {
        notNull: true,
        type: "timestamp with time zone",
      },
      entitlement_period_ends_at: {
        notNull: true,
        type: "timestamp with time zone",
      },
      limit_micros: { notNull: true, type: "bigint" },
      lease_id: { notNull: false, type: "uuid" },
      lease_kind: { notNull: false, type: "text" },
      lease_expires_at: {
        notNull: false,
        type: "timestamp with time zone",
      },
      revoked_at: { notNull: false, type: "timestamp with time zone" },
    });
    expect(hostedProviderKeys.limitMicros.mapFromDriverValue("9007199254740901")).toBe(
      9_007_199_254_740_901n,
    );
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]!.onDelete).toBe("restrict");
  });

  test("uses one generated migration after renewable CLI sessions", async () => {
    const migrationsDirectory = new URL("../drizzle/", import.meta.url);
    const migrations = (await readdir(migrationsDirectory))
      .filter((file) => /^005[1-4]_.*[.]sql$/.test(file))
      .sort();
    const migration = await readFile(
      new URL("../drizzle/0053_wonderful_annihilus.sql", import.meta.url),
      "utf8",
    );
    const previousMigration = await readFile(
      new URL(
        "../drizzle/0052_file_level_publication_receipts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const previousSnapshot = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/0052_snapshot.json", import.meta.url),
        "utf8",
      ),
    ) as { id: string };
    const snapshot = providerKeySnapshot as { id: string; prevId: string };
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(migrations).toEqual([
      "0051_refreshable_cli_sessions.sql",
      "0052_file_level_publication_receipts.sql",
      "0053_wonderful_annihilus.sql",
    ]);
    expect(previousMigration).not.toContain("hosted_provider_keys");
    expect(migration).toContain('CREATE TABLE "hosted_provider_keys"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "hosted_provider_keys_provider_key_hash_unique"',
    );
    expect(migration).toContain('WHERE "hosted_provider_keys"."provider_key_hash" IS NOT NULL');
    expect(migration).toContain("DEFAULT clock_timestamp()");
    expect(migration).not.toMatch(/ALTER TABLE "cli_refresh_(?:sessions|tokens)"/);
    expect(snapshot.prevId).toBe(previousSnapshot.id);
    expect(snapshot.id).not.toBe(previousSnapshot.id);
    expect(journal.entries.at(-1)).toEqual(
      expect.objectContaining({ idx: 52, tag: "0053_wonderful_annihilus" }),
    );
  });

  test("keeps lifecycle time authority in PostgreSQL", async () => {
    const source = await readFile(
      new URL("../src/lib/hosted-provider-key-lifecycle.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("clock_timestamp()");
    expect(source).not.toMatch(/Date[.]now|new Date[(]/);
    expect(source).not.toContain("input.now");
  });
});
