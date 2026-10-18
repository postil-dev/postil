import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import {
  OPENROUTER_EXACT_LIMIT_MAX_MICROS,
  OPENROUTER_PROVIDER_BINDING,
  type ExactOpenRouterLimitMicros,
  type OpenRouterManagedKey,
  type OpenRouterManagementAdapter,
} from "@/lib/openrouter-management-adapter";
import {
  HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
  hostedProviderKeyLifecycleJobPayload,
} from "@/lib/queue";
import {
  activateHostedInferenceRelease,
  HostedInferenceReleaseDarkError,
} from "@/lib/release-job-rollout";
import {
  runHostedProviderKeyLifecycleJob,
  validateHostedProviderKeyLifecycleJobPayload,
} from "@/worker/hosted-provider-key-lifecycle";
import {
  PROCESSABLE_JOB_KINDS,
  WEB_PROCESSABLE_JOB_KINDS,
} from "@/worker/runner";

import "./quiet-console";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
let nextGithubOrgId = 8_100_000;

class RecordingProvider implements OpenRouterManagementAdapter {
  readonly binding = OPENROUTER_PROVIDER_BINDING;
  readonly calls = {
    exactName: 0,
    exactHash: 0,
    create: 0,
    disable: 0,
  };
  readonly keys = new Map<string, OpenRouterManagedKey>();

  async findKeysByExactName(name: string) {
    this.calls.exactName += 1;
    const matches = [...this.keys.values()].filter((key) => key.name === name);
    if (matches.length === 0) {
      return {
        status: "none" as const,
        binding: this.binding,
        name,
        matches: [] as const,
      };
    }
    if (matches.length === 1) {
      return {
        status: "one" as const,
        binding: this.binding,
        name,
        matches: [matches[0]!] as const,
      };
    }
    return {
      status: "multiple" as const,
      binding: this.binding,
      name,
      matches,
    };
  }

  async findKeyByHash(hash: string) {
    this.calls.exactHash += 1;
    const key = this.keys.get(hash);
    return key
      ? { status: "present" as const, binding: this.binding, hash, key }
      : {
          status: "absent" as const,
          binding: this.binding,
          hash,
          key: null,
        };
  }

  async createKeyAfterPersistedIntent(input: {
    intentId: string;
    name: string;
    limitMicros: ExactOpenRouterLimitMicros;
    expiresAt: Date;
  }) {
    this.calls.create += 1;
    const key = {
      hash: `hash-${input.intentId}`,
      name: input.name,
      disabled: false,
    };
    this.keys.set(key.hash, key);
    return {
      status: "created" as const,
      binding: this.binding,
      key,
      runtimeKey: `runtime-${input.intentId}`,
      limitMicros: input.limitMicros,
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  async disableKey(hash: string) {
    this.calls.disable += 1;
    const existing = this.keys.get(hash);
    if (!existing) {
      return {
        status: "rejected" as const,
        binding: this.binding,
        httpStatus: 404,
      };
    }
    const key = { ...existing, disabled: true };
    this.keys.set(hash, key);
    return { status: "disabled" as const, binding: this.binding, key };
  }

  totalCalls(): number {
    return Object.values(this.calls).reduce((total, count) => total + count, 0);
  }
}

test("validates the durable job identity and keeps it off web drains", () => {
  const payload = hostedProviderKeyLifecycleJobPayload(
    42,
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  expect(payload).toEqual({
    orgId: 42,
    releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  expect(validateHostedProviderKeyLifecycleJobPayload(payload)).toEqual(
    payload,
  );
  expect(() =>
    validateHostedProviderKeyLifecycleJobPayload({
      ...payload,
      unexpected: true,
    }),
  ).toThrow("payload is malformed");
  expect(PROCESSABLE_JOB_KINDS).toContain(
    HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
  );
  expect(WEB_PROCESSABLE_JOB_KINDS as readonly string[]).not.toContain(
    HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
  );
});

test("activates hosted inference before self-service backfill", async () => {
  const source = await readFile(
    join(import.meta.dir, "..", "scripts", "activate-release-jobs.ts"),
    "utf8",
  );
  expect(
    source.indexOf("await activateHostedInferenceRelease"),
  ).toBeGreaterThan(0);
  expect(source.indexOf("await activateHostedInferenceRelease")).toBeLessThan(
    source.indexOf("await backfillSelfServiceTrials"),
  );
});

describeDb("hosted provider key lifecycle worker activation", () => {
  const databaseName = `postil_hosted_key_worker_${process.pid}_${Date.now()}`;
  const releaseSha = "abababababababababababababababababababab";
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
    pool = new Pool({ connectionString: url.toString(), max: 4 });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin?.end();
  }, 30_000);

  test("makes zero provider calls while dark or ineligible and creates only after activation", async () => {
    const activeOrgId = await insertOrganization(pool, "active-hosted");
    await insertEntitlement(pool, activeOrgId, {
      mode: "hosted",
      status: "active",
      period: "current",
      limitMicros: 100_000_000n,
    });
    const activePayload = hostedProviderKeyLifecycleJobPayload(
      activeOrgId,
      releaseSha,
    );
    const darkProvider = new RecordingProvider();
    await expect(
      runHostedProviderKeyLifecycleJob(activePayload, {
        pool,
        adapter: darkProvider,
        releaseSha,
        hostedInferenceEnabled: true,
        sealRuntimeKey: (runtimeKey) => Buffer.from(`sealed:${runtimeKey}`),
      }),
    ).rejects.toBeInstanceOf(HostedInferenceReleaseDarkError);
    expect(darkProvider.totalCalls()).toBe(0);
    expect(await lifecycleJobCount(pool, activeOrgId)).toBe(0);

    expect(await activateHostedInferenceRelease(pool, releaseSha)).toBe(true);
    expect(await lifecycleJobCount(pool, activeOrgId)).toBe(1);

    const activeProvider = new RecordingProvider();
    const continuation = await runHostedProviderKeyLifecycleJob(activePayload, {
      pool,
      adapter: activeProvider,
      releaseSha,
      hostedInferenceEnabled: true,
      sealRuntimeKey: (runtimeKey) => Buffer.from(`sealed:${runtimeKey}`),
    });
    expect(continuation?.payload).toEqual(activePayload);
    expect(activeProvider.calls).toEqual({
      exactName: 1,
      exactHash: 0,
      create: 1,
      disable: 0,
    });
    expect(
      (
        await pool.query<{ state: string }>(
          "SELECT state FROM hosted_provider_keys WHERE org_id = $1",
          [activeOrgId],
        )
      ).rows[0]?.state,
    ).toBe("active");

    expect(await activateHostedInferenceRelease(pool, releaseSha)).toBe(false);
    expect(await lifecycleJobCount(pool, activeOrgId)).toBe(1);

    const ineligible = [
      {
        slug: "byok",
        mode: "byok",
        status: "active",
        period: "current",
        limit: 1n,
      },
      {
        slug: "suspended",
        mode: "hosted",
        status: "suspended",
        period: "current",
        limit: 1n,
      },
      {
        slug: "expired",
        mode: "hosted",
        status: "active",
        period: "expired",
        limit: 1n,
      },
      {
        slug: "zero",
        mode: "hosted",
        status: "active",
        period: "current",
        limit: 0n,
      },
      {
        slug: "unrepresentable",
        mode: "hosted",
        status: "active",
        period: "current",
        limit: OPENROUTER_EXACT_LIMIT_MAX_MICROS + 1n,
      },
    ] as const;
    for (const candidate of ineligible) {
      const orgId = await insertOrganization(pool, candidate.slug);
      await insertEntitlement(pool, orgId, {
        mode: candidate.mode,
        status: candidate.status,
        period: candidate.period,
        limitMicros: candidate.limit,
      });
      const provider = new RecordingProvider();
      const result = await runHostedProviderKeyLifecycleJob(
        hostedProviderKeyLifecycleJobPayload(orgId, releaseSha),
        {
          pool,
          adapter: provider,
          releaseSha,
          hostedInferenceEnabled: true,
          sealRuntimeKey: (runtimeKey) => Buffer.from(`sealed:${runtimeKey}`),
        },
      );
      expect(result?.payload).toEqual(
        hostedProviderKeyLifecycleJobPayload(orgId, releaseSha),
      );
      expect(provider.totalCalls()).toBe(0);
    }
  }, 30_000);
});

async function insertOrganization(pool: Pool, slug: string): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO organizations (slug, name, github_org_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [slug, slug, nextGithubOrgId++],
  );
  return Number(result.rows[0]!.id);
}

async function insertEntitlement(
  pool: Pool,
  orgId: number,
  input: {
    mode: "hosted" | "byok";
    status: "active" | "suspended";
    period: "current" | "expired";
    limitMicros: bigint;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_entitlements (
       org_id, subscription_mode, status, period_starts_at, period_ends_at,
       included_usage_micros, overage_hard_cap_micros, updated_by
     ) VALUES (
       $1, $2, $3,
       CASE WHEN $4 = 'current' THEN now() - interval '1 day' ELSE now() - interval '2 days' END,
       CASE WHEN $4 = 'current' THEN now() + interval '30 days' ELSE now() - interval '1 day' END,
       $5, 0, 'hosted-provider-worker-test'
     )`,
    [
      orgId,
      input.mode,
      input.status,
      input.period,
      input.limitMicros.toString(),
    ],
  );
}

async function lifecycleJobCount(pool: Pool, orgId: number): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM jobs
      WHERE kind = $1 AND payload->>'orgId' = $2`,
    [HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND, String(orgId)],
  );
  return result.rows[0]?.count ?? 0;
}
