import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { getTableConfig } from "drizzle-orm/pg-core";

import { hostedProviderKeys } from "@/lib/db/schema";

describe("hosted provider key lifecycle schema", () => {
  test("binds one restricted lifecycle row to each organization", () => {
    const config = getTableConfig(hostedProviderKeys);
    const orgId = config.columns.find((column) => column.name === "org_id");
    const foreignKey = config.foreignKeys.find(
      (key) => key.reference().columns[0]?.name === "org_id",
    );

    expect(config.name).toBe("hosted_provider_keys");
    expect(orgId).toMatchObject({ notNull: true, primary: true });
    expect(foreignKey).toBeDefined();
    expect(foreignKey!.onDelete).toBe("restrict");
    expect(foreignKey!.reference().foreignColumns[0]?.name).toBe("id");
  });

  test("keeps provider credentials nullable and lifecycle fields durable", () => {
    const config = getTableConfig(hostedProviderKeys);
    const columns = Object.fromEntries(
      config.columns.map((column) => [
        column.name,
        {
          notNull: column.notNull,
          type: column.getSQLType(),
        },
      ]),
    );

    expect(columns).toMatchObject({
      state: { notNull: true, type: "text" },
      provider_key_name: { notNull: true, type: "text" },
      sealed_runtime_key: { notNull: false, type: "bytea" },
      provider_key_hash: { notNull: false, type: "text" },
      limit_micros: { notNull: true, type: "bigint" },
      created_at: { notNull: true, type: "timestamp with time zone" },
      updated_at: { notNull: true, type: "timestamp with time zone" },
    });
    expect(config.checks.map((check) => check.name).sort()).toEqual(
      [
        "hosted_provider_keys_credentials_match_state",
        "hosted_provider_keys_limit_micros_nonnegative",
        "hosted_provider_keys_provider_key_hash_nonempty",
        "hosted_provider_keys_provider_key_name_nonempty",
        "hosted_provider_keys_state_check",
      ].sort(),
    );
    expect(
      hostedProviderKeys.limitMicros.mapFromDriverValue("9007199254740993"),
    ).toBe(9_007_199_254_740_993n);
  });

  test("preserves migration numbering and snapshot ancestry", async () => {
    const migration = await readFile(
      new URL(
        "../drizzle/0053_hosted_provider_key_lifecycle.sql",
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
    const snapshot = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/0053_snapshot.json", import.meta.url),
        "utf8",
      ),
    ) as { id: string; prevId: string };
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(snapshot.id).not.toBe(previousSnapshot.id);
    expect(snapshot.prevId).toBe(previousSnapshot.id);
    expect(journal.entries.at(-2)).toEqual(
      expect.objectContaining({
        idx: 51,
        tag: "0052_file_level_publication_receipts",
      }),
    );
    expect(journal.entries.at(-1)).toEqual(
      expect.objectContaining({
        idx: 52,
        tag: "0053_hosted_provider_key_lifecycle",
      }),
    );
    expect(migration).toContain('CREATE TABLE "hosted_provider_keys"');
    expect(migration).toContain(
      'FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict',
    );
    expect(migration).not.toMatch(/ON DELETE cascade/i);
  });
});
