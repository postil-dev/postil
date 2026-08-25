import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Pool } from "pg";

import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("hosted provider key lifecycle migration", () => {
  let database: EphemeralDatabase | undefined;
  let pool: Pool;

  beforeAll(async () => {
    database = await createEphemeralDatabase("hosted_provider_key_lifecycle");
    pool = database.pool;
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function createOrganization(suffix: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ($1, $2)
       RETURNING id`,
      [`provider-key-${suffix}`, `Provider key ${suffix}`],
    );
    return result.rows[0]!.id;
  }

  test("accepts only lifecycle states with their required credential shape", async () => {
    const states = [
      {
        state: "provisioning",
        sealedRuntimeKey: null,
        providerKeyHash: null,
      },
      {
        state: "active",
        sealedRuntimeKey: Buffer.from("sealed-active-key"),
        providerKeyHash: "active-provider-hash",
      },
      {
        state: "revocation_pending",
        sealedRuntimeKey: null,
        providerKeyHash: "pending-provider-hash",
      },
      {
        state: "revoked",
        sealedRuntimeKey: null,
        providerKeyHash: "revoked-provider-hash",
      },
      {
        state: "orphaned",
        sealedRuntimeKey: null,
        providerKeyHash: null,
      },
      {
        state: "orphaned",
        sealedRuntimeKey: null,
        providerKeyHash: "orphaned-provider-hash",
      },
    ] as const;

    for (const [index, row] of states.entries()) {
      const orgId = await createOrganization(`valid-${index}`);
      await expect(
        pool.query(
          `INSERT INTO hosted_provider_keys
             (org_id, state, provider_key_name, sealed_runtime_key,
              provider_key_hash, limit_micros)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            orgId,
            row.state,
            `opaque-provider-name-${index}`,
            row.sealedRuntimeKey,
            row.providerKeyHash,
            300_000,
          ],
        ),
      ).resolves.toBeDefined();
    }
  });

  test("rejects invalid state, credential, identity, and limit combinations", async () => {
    const invalidRows = [
      {
        state: "unknown",
        name: "opaque-invalid-state",
        sealedRuntimeKey: null,
        providerKeyHash: null,
        limitMicros: 0,
      },
      {
        state: "active",
        name: "opaque-missing-runtime-key",
        sealedRuntimeKey: null,
        providerKeyHash: "provider-hash",
        limitMicros: 0,
      },
      {
        state: "provisioning",
        name: "opaque-premature-hash",
        sealedRuntimeKey: null,
        providerKeyHash: "provider-hash",
        limitMicros: 0,
      },
      {
        state: "revoked",
        name: "opaque-revoked-runtime-key",
        sealedRuntimeKey: Buffer.from("sealed-key"),
        providerKeyHash: "provider-hash",
        limitMicros: 0,
      },
      {
        state: "provisioning",
        name: " ",
        sealedRuntimeKey: null,
        providerKeyHash: null,
        limitMicros: 0,
      },
      {
        state: "active",
        name: "opaque-empty-hash",
        sealedRuntimeKey: Buffer.from("sealed-key"),
        providerKeyHash: " ",
        limitMicros: 0,
      },
      {
        state: "provisioning",
        name: "opaque-negative-limit",
        sealedRuntimeKey: null,
        providerKeyHash: null,
        limitMicros: -1,
      },
    ] as const;

    for (const [index, row] of invalidRows.entries()) {
      const orgId = await createOrganization(`invalid-${index}`);
      await expect(
        pool.query(
          `INSERT INTO hosted_provider_keys
             (org_id, state, provider_key_name, sealed_runtime_key,
              provider_key_hash, limit_micros)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            orgId,
            row.state,
            row.name,
            row.sealedRuntimeKey,
            row.providerKeyHash,
            row.limitMicros,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  test("enforces one row per organization and restricts organization deletion", async () => {
    const orgId = await createOrganization("ownership");
    await pool.query(
      `INSERT INTO hosted_provider_keys
         (org_id, state, provider_key_name, limit_micros)
       VALUES ($1, 'provisioning', 'opaque-owner-name', 0)`,
      [orgId],
    );

    await expect(
      pool.query(
        `INSERT INTO hosted_provider_keys
           (org_id, state, provider_key_name, limit_micros)
         VALUES ($1, 'provisioning', 'opaque-duplicate-name', 0)`,
        [orgId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query("DELETE FROM organizations WHERE id = $1", [orgId]),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
