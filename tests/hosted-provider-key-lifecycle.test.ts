import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Pool } from "pg";

import {
  reconcileHostedProviderKeyLifecycle,
  resolveHostedProviderRuntimeCredential,
} from "@/lib/hosted-provider-key-lifecycle";
import {
  exactOpenRouterLimitMicros,
  OPENROUTER_PROVIDER_BINDING,
  type ExactOpenRouterLimitMicros,
  type OpenRouterCreateKeyResult,
  type OpenRouterDisableKeyResult,
  type OpenRouterManagedKey,
  type OpenRouterManagementAdapter,
} from "@/lib/openrouter-management-adapter";
import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

interface EntitlementFixture {
  readonly orgId: number;
  readonly periodStartsAt: Date;
  readonly periodEndsAt: Date;
  readonly limitMicros: bigint;
}

describeDb("hosted provider key lifecycle", () => {
  let database: EphemeralDatabase | undefined;
  let pool: Pool;

  beforeAll(async () => {
    database = await createEphemeralDatabase(
      "hosted_provider_key_lifecycle_v2",
    );
    pool = database.pool;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function createEntitlement(
    suffix: string,
    limitMicros = 300_001n,
  ): Promise<EntitlementFixture> {
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ($1, $2)
       RETURNING id`,
      [`provider-lifecycle-${suffix}`, `Provider lifecycle ${suffix}`],
    );
    const orgId = Number(organization.rows[0]!.id);
    const entitlement = await pool.query<{
      period_starts_at: Date;
      period_ends_at: Date;
    }>(
      `INSERT INTO organization_entitlements
         (org_id, subscription_mode, status, period_starts_at, period_ends_at,
          included_usage_micros, overage_hard_cap_micros,
          included_usage_cents, overage_hard_cap_cents, updated_by)
       VALUES
         ($1, 'hosted', 'active', clock_timestamp() - interval '1 hour',
          clock_timestamp() + interval '1 day', $2::bigint, 0, 0, 0, 'test')
       RETURNING period_starts_at, period_ends_at`,
      [orgId, limitMicros.toString()],
    );
    return {
      orgId,
      periodStartsAt: entitlement.rows[0]!.period_starts_at,
      periodEndsAt: entitlement.rows[0]!.period_ends_at,
      limitMicros,
    };
  }

  test("creates one key bound to the exact active period and cap", async () => {
    const entitlement = await createEntitlement("exact-binding", 1_234_567n);
    const provider = new FakeProvider();

    const created = await reconcileHostedProviderKeyLifecycle(
      pool,
      provider.adapter,
      {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(`sealed:${runtimeKey}`),
      },
    );

    expect(created).toMatchObject({
      status: "created",
      periodStartsAt: entitlement.periodStartsAt,
      periodEndsAt: entitlement.periodEndsAt,
      limitMicros: 1_234_567n,
    });
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]).toMatchObject({
      limitMicros: 1_234_567n,
      expiresAt: entitlement.periodEndsAt,
    });
    expect(provider.createCalls[0]!.name).toMatch(
      /^postil-hosted-[0-9a-f-]{36}$/,
    );

    const credential = await resolveHostedProviderRuntimeCredential(
      pool,
      entitlement.orgId,
    );
    expect(credential).toMatchObject({
      limitMicros: 1_234_567n,
      periodStartsAt: entitlement.periodStartsAt,
      periodEndsAt: entitlement.periodEndsAt,
    });
    expect(credential!.sealedRuntimeKey).toEqual(
      Buffer.from(`sealed:runtime-${credential!.providerKeyHash}`),
    );

    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({ status: "active" });
    expect(provider.createCalls).toHaveLength(1);
  });

  test("releases pooled database clients before every provider operation", async () => {
    const entitlement = await createEntitlement("released-provider-io");
    const provider = new FakeProvider();
    let assertions = 0;
    provider.beforeProviderOperation = () => {
      assertions += 1;
      expect(pool.totalCount - pool.idleCount).toBe(0);
    };

    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({ status: "created" });
    await pool.query(
      `UPDATE organization_entitlements
       SET status = 'suspended', updated_at = clock_timestamp()
       WHERE org_id = $1`,
      [entitlement.orgId],
    );
    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({ status: "inactive", revocationsCompleted: 1 });

    expect(assertions).toBeGreaterThanOrEqual(5);
  });

  test("revokes the old period before activating a rollover key", async () => {
    const entitlement = await createEntitlement("rollover", 400_001n);
    const provider = new FakeProvider();
    const first = await reconcileHostedProviderKeyLifecycle(
      pool,
      provider.adapter,
      {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(`sealed:${runtimeKey}`),
      },
    );
    expect(first.status).toBe("created");
    const firstHash = provider.createCalls[0]!.hash;

    let credentialWasClearedBeforeDisable = false;
    provider.beforeDisable = async (hash) => {
      const persisted = await pool.query<{
        state: string;
        sealed_runtime_key: Buffer | null;
      }>(
        `SELECT state, sealed_runtime_key
         FROM hosted_provider_keys
         WHERE provider_key_hash = $1`,
        [hash],
      );
      credentialWasClearedBeforeDisable =
        persisted.rows[0]?.state === "revocation_pending" &&
        persisted.rows[0]?.sealed_runtime_key === null;
    };
    const nextPeriod = await pool.query<{
      period_starts_at: Date;
      period_ends_at: Date;
    }>(
      `UPDATE organization_entitlements
       SET period_starts_at = clock_timestamp() - interval '1 minute',
           period_ends_at = clock_timestamp() + interval '2 days',
           included_usage_micros = 500002,
           updated_at = clock_timestamp()
       WHERE org_id = $1
       RETURNING period_starts_at, period_ends_at`,
      [entitlement.orgId],
    );

    const rollover = await reconcileHostedProviderKeyLifecycle(
      pool,
      provider.adapter,
      {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(`sealed:${runtimeKey}`),
      },
    );

    expect(rollover).toMatchObject({
      status: "created",
      periodStartsAt: nextPeriod.rows[0]!.period_starts_at,
      periodEndsAt: nextPeriod.rows[0]!.period_ends_at,
      limitMicros: 500_002n,
    });
    expect(credentialWasClearedBeforeDisable).toBe(true);
    expect(provider.key(firstHash)?.disabled).toBe(true);
    expect(provider.createCalls).toHaveLength(2);
    expect(provider.createCalls[1]).toMatchObject({
      limitMicros: 500_002n,
      expiresAt: nextPeriod.rows[0]!.period_ends_at,
    });
    const rows = await pool.query<{
      state: string;
      sealed_runtime_key: Buffer | null;
      revoke_outcome: string | null;
    }>(
      `SELECT state, sealed_runtime_key, revoke_outcome
       FROM hosted_provider_keys
       WHERE org_id = $1
       ORDER BY entitlement_period_ends_at`,
      [entitlement.orgId],
    );
    expect(rows.rows.map((row) => row.state)).toEqual(["revoked", "active"]);
    expect(rows.rows[0]).toMatchObject({
      sealed_runtime_key: null,
      revoke_outcome: "disabled",
    });
  });

  test("suspension and period expiry leave no active credential", async () => {
    for (const mode of ["suspended", "expired"] as const) {
      const entitlement = await createEntitlement(mode);
      const provider = new FakeProvider();
      await reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      });
      if (mode === "suspended") {
        await pool.query(
          `UPDATE organization_entitlements
           SET status = 'suspended', updated_at = clock_timestamp()
           WHERE org_id = $1`,
          [entitlement.orgId],
        );
      } else {
        await pool.query(
          `UPDATE organization_entitlements
           SET period_ends_at = clock_timestamp() - interval '1 minute',
               updated_at = clock_timestamp()
           WHERE org_id = $1`,
          [entitlement.orgId],
        );
      }

      const result = await reconcileHostedProviderKeyLifecycle(
        pool,
        provider.adapter,
        {
          orgId: entitlement.orgId,
          sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
        },
      );
      expect(result).toMatchObject({
        status: "inactive",
        reason: mode === "suspended" ? "suspended" : "period-not-current",
        revocationsCompleted: 1,
      });
      expect(
        await resolveHostedProviderRuntimeCredential(pool, entitlement.orgId),
      ).toBeNull();
      expect(provider.activeKeys()).toEqual([]);
      const row = await pool.query<{
        state: string;
        sealed_runtime_key: Buffer | null;
      }>(
        `SELECT state, sealed_runtime_key
         FROM hosted_provider_keys
         WHERE org_id = $1`,
        [entitlement.orgId],
      );
      expect(row.rows[0]).toEqual({
        state: "revoked",
        sealed_runtime_key: null,
      });
    }
  });

  test("keeps an ambiguous disable pending until hash observation proves revocation", async () => {
    const entitlement = await createEntitlement("ambiguous-disable");
    const provider = new FakeProvider();
    await reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
      orgId: entitlement.orgId,
      sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
    });
    const hash = provider.createCalls[0]!.hash;
    provider.disableMode = "ambiguous-active";
    await pool.query(
      `UPDATE organization_entitlements
       SET status = 'suspended', updated_at = clock_timestamp()
       WHERE org_id = $1`,
      [entitlement.orgId],
    );

    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({
      status: "revocation-pending",
      providerKeyHash: hash,
    });
    const pending = await pool.query<{
      state: string;
      sealed_runtime_key: Buffer | null;
      revoke_outcome: string | null;
      revoked_at: Date | null;
    }>(
      `SELECT state, sealed_runtime_key, revoke_outcome, revoked_at
       FROM hosted_provider_keys
       WHERE provider_key_hash = $1`,
      [hash],
    );
    expect(pending.rows[0]).toEqual({
      state: "revocation_pending",
      sealed_runtime_key: null,
      revoke_outcome: "ambiguous",
      revoked_at: null,
    });

    provider.disableExternally(hash);
    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({
      status: "inactive",
      revocationsCompleted: 1,
    });
    expect(provider.disableCalls).toEqual([hash]);
    const revoked = await pool.query<{
      state: string;
      revoke_outcome: string;
      revoked_at: Date;
    }>(
      `SELECT state, revoke_outcome, revoked_at
       FROM hosted_provider_keys
       WHERE provider_key_hash = $1`,
      [hash],
    );
    expect(revoked.rows[0]).toMatchObject({
      state: "revoked",
      revoke_outcome: "disabled",
    });
    expect(revoked.rows[0]!.revoked_at).toBeInstanceOf(Date);
  });

  test("marks revocation complete when immutable-hash observation proves absence", async () => {
    const entitlement = await createEntitlement("absent-revocation");
    const provider = new FakeProvider();
    await reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
      orgId: entitlement.orgId,
      sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
    });
    const hash = provider.createCalls[0]!.hash;
    provider.remove(hash);
    await pool.query(
      `UPDATE organization_entitlements
       SET status = 'suspended', updated_at = clock_timestamp()
       WHERE org_id = $1`,
      [entitlement.orgId],
    );

    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({
      status: "inactive",
      reason: "suspended",
      revocationsCompleted: 1,
    });
    expect(provider.disableCalls).toEqual([]);
    const row = await pool.query<{
      state: string;
      revoke_outcome: string;
      sealed_runtime_key: Buffer | null;
    }>(
      `SELECT state, revoke_outcome, sealed_runtime_key
       FROM hosted_provider_keys
       WHERE provider_key_hash = $1`,
      [hash],
    );
    expect(row.rows[0]).toEqual({
      state: "revoked",
      revoke_outcome: "absent",
      sealed_runtime_key: null,
    });
  });

  test("never recreates an ambiguous create intent", async () => {
    const entitlement = await createEntitlement("ambiguous-create");
    const provider = new FakeProvider();
    provider.createMode = "ambiguous-absent";

    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({
      status: "orphaned",
      reason: "provider-outcome-ambiguous",
    });
    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({
      status: "orphaned",
      reason: "attempted-without-provider-match",
    });
    expect(provider.createCalls).toHaveLength(1);
  });

  test("turns a known create result with an expired lease into durable revocation", async () => {
    const entitlement = await createEntitlement("expired-create-lease");
    const provider = new FakeProvider();
    provider.afterCreate = async ({ name }) => {
      await pool.query(
        `UPDATE hosted_provider_keys
         SET lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE provider_key_name = $1`,
        [name],
      );
    };

    const result = await reconcileHostedProviderKeyLifecycle(
      pool,
      provider.adapter,
      {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      },
    );

    expect(result).toMatchObject({ status: "revoked", observed: "disabled" });
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.disableCalls).toEqual([provider.createCalls[0]!.hash]);
    const row = await pool.query<{
      state: string;
      provider_key_hash: string;
      sealed_runtime_key: Buffer | null;
      revoke_outcome: string;
    }>(
      `SELECT state, provider_key_hash, sealed_runtime_key, revoke_outcome
       FROM hosted_provider_keys
       WHERE org_id = $1`,
      [entitlement.orgId],
    );
    expect(row.rows[0]).toEqual({
      state: "revoked",
      provider_key_hash: provider.createCalls[0]!.hash,
      sealed_runtime_key: null,
      revoke_outcome: "disabled",
    });
  });

  test("revokes a created key when runtime credential sealing fails", async () => {
    const entitlement = await createEntitlement("seal-failure");
    const provider = new FakeProvider();

    const result = await reconcileHostedProviderKeyLifecycle(
      pool,
      provider.adapter,
      {
        orgId: entitlement.orgId,
        sealRuntimeKey() {
          throw new Error("test sealer failure");
        },
      },
    );

    expect(result).toMatchObject({ status: "revoked", observed: "disabled" });
    expect(provider.disableCalls).toEqual([provider.createCalls[0]!.hash]);
    const row = await pool.query<{
      state: string;
      create_outcome: string;
      sealed_runtime_key: Buffer | null;
      revoke_outcome: string;
    }>(
      `SELECT state, create_outcome, sealed_runtime_key, revoke_outcome
       FROM hosted_provider_keys
       WHERE org_id = $1`,
      [entitlement.orgId],
    );
    expect(row.rows[0]).toEqual({
      state: "revoked",
      create_outcome: "credential_persistence_failed",
      sealed_runtime_key: null,
      revoke_outcome: "disabled",
    });
  });

  test("revokes a recovered ambiguous create before creating its successor", async () => {
    const entitlement = await createEntitlement("ambiguous-created");
    const provider = new FakeProvider();
    provider.createMode = "ambiguous-created";

    await reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
      orgId: entitlement.orgId,
      sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
    });
    const hash = provider.createCalls[0]!.hash;
    provider.createMode = "created";
    const result = await reconcileHostedProviderKeyLifecycle(
      pool,
      provider.adapter,
      {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      },
    );

    expect(result).toMatchObject({ status: "created" });
    expect(provider.createCalls).toHaveLength(2);
    expect(provider.disableCalls).toEqual([hash]);
    expect(provider.key(hash)?.disabled).toBe(true);
    const rows = await pool.query<{ state: string; create_intent_id: string }>(
      `SELECT state, create_intent_id
       FROM hosted_provider_keys
       WHERE org_id = $1
       ORDER BY created_at`,
      [entitlement.orgId],
    );
    expect(rows.rows.map((row) => row.state)).toEqual(["revoked", "active"]);
    expect(new Set(rows.rows.map((row) => row.create_intent_id)).size).toBe(2);
  });

  test("preserves a rate-limited intent and succeeds with a successor", async () => {
    const entitlement = await createEntitlement("rate-limited-successor");
    const provider = new FakeProvider();
    provider.createMode = "retryable";

    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({
      status: "retryable",
      operation: "create",
      httpStatus: 429,
    });
    provider.createMode = "created";
    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toMatchObject({ status: "created" });

    expect(provider.createCalls).toHaveLength(2);
    const rows = await pool.query<{
      state: string;
      create_outcome: string;
      create_intent_id: string;
    }>(
      `SELECT state, create_outcome, create_intent_id
       FROM hosted_provider_keys
       WHERE org_id = $1
       ORDER BY created_at`,
      [entitlement.orgId],
    );
    expect(
      rows.rows.map(({ state, create_outcome }) => ({
        state,
        create_outcome,
      })),
    ).toEqual([
      { state: "cancelled", create_outcome: "rate_limited" },
      { state: "active", create_outcome: "created" },
    ]);
    expect(new Set(rows.rows.map((row) => row.create_intent_id)).size).toBe(2);
  });

  test("records ownership conflict without mutating a hash owned by another intent", async () => {
    const owner = await createEntitlement("hash-owner");
    const contender = await createEntitlement("hash-contender");
    const ownerIntent = "11111111-1111-4111-8111-111111111111";
    const contenderIntent = "22222222-2222-4222-8222-222222222222";
    const sharedHash = "shared-provider-hash";
    const contenderName = "postil-hosted-22222222-2222-4222-8222-222222222222";
    await pool.query(
      `INSERT INTO hosted_provider_keys
         (create_intent_id, org_id, state, provider_key_name, provider_key_hash,
          sealed_runtime_key, entitlement_period_starts_at,
          entitlement_period_ends_at, entitlement_updated_at, limit_micros,
          create_attempted_at, create_outcome)
       SELECT $1, e.org_id, 'active', $2, $3, $4, e.period_starts_at,
              e.period_ends_at, e.updated_at,
              e.included_usage_micros + COALESCE(e.overage_hard_cap_micros, 0),
              clock_timestamp(), 'created'
       FROM organization_entitlements e
       WHERE e.org_id = $5`,
      [
        ownerIntent,
        "postil-hosted-11111111-1111-4111-8111-111111111111",
        sharedHash,
        Buffer.from("sealed-owner"),
        owner.orgId,
      ],
    );
    await pool.query(
      `INSERT INTO hosted_provider_keys
         (create_intent_id, org_id, state, provider_key_name,
          entitlement_period_starts_at, entitlement_period_ends_at,
          entitlement_updated_at, limit_micros, create_attempted_at,
          create_outcome, reconciliation_required_at)
       SELECT $1, e.org_id, 'orphaned', $2, e.period_starts_at,
              e.period_ends_at, e.updated_at,
              e.included_usage_micros + COALESCE(e.overage_hard_cap_micros, 0),
              clock_timestamp(), 'ambiguous', clock_timestamp()
       FROM organization_entitlements e
       WHERE e.org_id = $3`,
      [contenderIntent, contenderName, contender.orgId],
    );
    const provider = new FakeProvider();
    provider.inject(contenderName, sharedHash);

    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: contender.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toEqual({
      status: "ownership-conflict",
      intentId: contenderIntent,
      providerKeyHash: sharedHash,
    });
    expect(provider.disableCalls).toEqual([]);
    const conflict = await pool.query<{
      state: string;
      provider_key_hash: string | null;
      conflicting_provider_key_hash: string;
      create_outcome: string;
    }>(
      `SELECT state, provider_key_hash, conflicting_provider_key_hash,
              create_outcome
       FROM hosted_provider_keys
       WHERE create_intent_id = $1`,
      [contenderIntent],
    );
    expect(conflict.rows[0]).toEqual({
      state: "orphaned",
      provider_key_hash: null,
      conflicting_provider_key_hash: sharedHash,
      create_outcome: "ownership_conflict",
    });
  });

  test("rejects an inexact entitlement cap before any provider contact", async () => {
    const entitlement = await createEntitlement(
      "inexact-cap",
      9_007_199_254_740_901n,
    );
    const provider = new FakeProvider();

    await expect(
      reconcileHostedProviderKeyLifecycle(pool, provider.adapter, {
        orgId: entitlement.orgId,
        sealRuntimeKey: (runtimeKey) => Buffer.from(runtimeKey),
      }),
    ).resolves.toEqual({
      status: "inactive",
      reason: "limit-not-exactly-representable",
      revocationsCompleted: 0,
    });
    expect(provider.createCalls).toEqual([]);
    expect(provider.listCalls).toBe(0);
    expect(provider.disableCalls).toEqual([]);
  });
});

type CreateMode =
  "created" | "retryable" | "ambiguous-absent" | "ambiguous-created";
type DisableMode = "disabled" | "ambiguous-active" | "ambiguous-disabled";
let nextFakeProviderHash = 1;

class FakeProvider {
  readonly createCalls: Array<{
    name: string;
    hash: string;
    limitMicros: ExactOpenRouterLimitMicros;
    expiresAt: Date;
  }> = [];
  readonly disableCalls: string[] = [];
  listCalls = 0;
  createMode: CreateMode = "created";
  disableMode: DisableMode = "disabled";
  beforeDisable: ((hash: string) => Promise<void>) | undefined;
  afterCreate:
    | ((input: {
        readonly name: string;
        readonly hash: string;
      }) => Promise<void>)
    | undefined;
  beforeProviderOperation: (() => void) | undefined;
  readonly #keys = new Map<string, OpenRouterManagedKey>();

  readonly adapter: OpenRouterManagementAdapter = Object.freeze({
    binding: OPENROUTER_PROVIDER_BINDING,
    findKeysByExactName: async (name: string) => {
      this.beforeProviderOperation?.();
      this.listCalls += 1;
      const matches = [...this.#keys.values()]
        .filter((key) => key.name === name)
        .map(copyKey);
      if (matches.length === 0) {
        return {
          status: "none" as const,
          binding: OPENROUTER_PROVIDER_BINDING,
          name,
          matches: [] as const,
        };
      }
      if (matches.length === 1) {
        return {
          status: "one" as const,
          binding: OPENROUTER_PROVIDER_BINDING,
          name,
          matches: [matches[0]!] as const,
        };
      }
      return {
        status: "multiple" as const,
        binding: OPENROUTER_PROVIDER_BINDING,
        name,
        matches,
      };
    },
    findKeyByHash: async (hash: string) => {
      this.beforeProviderOperation?.();
      this.listCalls += 1;
      const key = this.#keys.get(hash);
      return key
        ? {
            status: "present" as const,
            binding: OPENROUTER_PROVIDER_BINDING,
            hash,
            key: copyKey(key),
          }
        : {
            status: "absent" as const,
            binding: OPENROUTER_PROVIDER_BINDING,
            hash,
            key: null,
          };
    },
    createKeyAfterPersistedIntent: async (
      input: Parameters<
        OpenRouterManagementAdapter["createKeyAfterPersistedIntent"]
      >[0],
    ): Promise<OpenRouterCreateKeyResult> => {
      this.beforeProviderOperation?.();
      const hash = `provider-hash-${nextFakeProviderHash}`;
      nextFakeProviderHash += 1;
      this.createCalls.push({
        name: input.name,
        hash,
        limitMicros: input.limitMicros,
        expiresAt: new Date(input.expiresAt),
      });
      if (this.createMode !== "ambiguous-absent") {
        this.inject(input.name, hash);
      }
      await this.afterCreate?.({ name: input.name, hash });
      if (this.createMode === "retryable") {
        this.#keys.delete(hash);
        return {
          status: "retryable",
          binding: OPENROUTER_PROVIDER_BINDING,
          httpStatus: 429,
        };
      }
      if (this.createMode !== "created") {
        return {
          status: "ambiguous",
          binding: OPENROUTER_PROVIDER_BINDING,
          reason: "timeout",
        };
      }
      return {
        status: "created",
        binding: OPENROUTER_PROVIDER_BINDING,
        key: copyKey(this.#keys.get(hash)!),
        runtimeKey: `runtime-${hash}`,
        limitMicros: input.limitMicros,
        expiresAt: input.expiresAt.toISOString(),
      };
    },
    disableKey: async (hash: string): Promise<OpenRouterDisableKeyResult> => {
      this.beforeProviderOperation?.();
      this.disableCalls.push(hash);
      await this.beforeDisable?.(hash);
      const key = this.#keys.get(hash);
      if (!key) {
        return {
          status: "rejected",
          binding: OPENROUTER_PROVIDER_BINDING,
          httpStatus: 404,
        };
      }
      if (this.disableMode !== "ambiguous-active") {
        this.#keys.set(hash, { ...key, disabled: true });
      }
      if (this.disableMode !== "disabled") {
        return {
          status: "ambiguous",
          binding: OPENROUTER_PROVIDER_BINDING,
          reason: "timeout",
        };
      }
      return {
        status: "disabled",
        binding: OPENROUTER_PROVIDER_BINDING,
        key: copyKey(this.#keys.get(hash)!),
      };
    },
  });

  inject(name: string, hash: string): void {
    this.#keys.set(hash, { name, hash, disabled: false });
  }

  disableExternally(hash: string): void {
    const key = this.#keys.get(hash);
    if (!key) throw new Error("provider key does not exist");
    this.#keys.set(hash, { ...key, disabled: true });
  }

  remove(hash: string): void {
    this.#keys.delete(hash);
  }

  key(hash: string): OpenRouterManagedKey | undefined {
    const key = this.#keys.get(hash);
    return key ? copyKey(key) : undefined;
  }

  activeKeys(): OpenRouterManagedKey[] {
    return [...this.#keys.values()].filter((key) => !key.disabled).map(copyKey);
  }
}

function copyKey(key: OpenRouterManagedKey): OpenRouterManagedKey {
  return { hash: key.hash, name: key.name, disabled: key.disabled };
}
