import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import release from "@/data/public-cli-release.json";

// Mirrors the private sha256() helper in src/lib/cli-auth.ts.
function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  REVIEW_MODEL: process.env.REVIEW_MODEL,
  REVIEW_MODEL_CASCADE: process.env.REVIEW_MODEL_CASCADE,
  POSTIL_API_BASE: process.env.POSTIL_API_BASE,
  POSTIL_API_FORMAT: process.env.POSTIL_API_FORMAT,
  MODEL_API_KEY: process.env.MODEL_API_KEY,
  POSTIL_CLI_GATEWAY_HOURLY_CAP: process.env.POSTIL_CLI_GATEWAY_HOURLY_CAP,
  POSTIL_HOSTED_INFERENCE_ENABLED: process.env.POSTIL_HOSTED_INFERENCE_ENABLED,
  POSTIL_PROVISIONAL_HOSTED_ROSTER: process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER,
  POSTIL_RELEASE_SHA: process.env.POSTIL_RELEASE_SHA,
};

test("uses the pinned CLI default when the managed provisional roster has no environment model", async () => {
  const { hostedModelRoster } = await import("@/lib/cli-gateway");
  expect(hostedModelRoster({}, "1")).toEqual([release.hostedCliDefaultModel]);
  expect(hostedModelRoster({}, "0")).toEqual([]);
  expect(hostedModelRoster({ model: "configured/model" }, "1")).toEqual([
    "configured/model",
  ]);
});

describeDb("POST /api/inference/v1/chat/completions", () => {
  const databaseName = `postil_cli_gateway_${process.pid}_${Date.now()}`;
  let adminClient: Client | undefined;
  let pool: Pool | undefined;
  let userId = 0;
  let orgCounter = 0;

  beforeAll(async () => {
    adminClient = new Client({ connectionString: TEST_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    const migrationClient = new Client({
      connectionString: databaseUrl.toString(),
    });
    await migrationClient.connect();
    const migrationsDir = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .sort();
    for (const file of migrations) {
      const source = await readFile(join(migrationsDir, file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migrationClient.query(statement);
      }
    }
    const user = await migrationClient.query<{ id: string }>(`
      INSERT INTO users (github_id, login) VALUES (990100, 'cli-gateway-user') RETURNING id;
    `);
    userId = Number(user.rows[0]?.id);
    await migrationClient.end();

    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.REVIEW_MODEL = "z-ai/glm-5.2";
    process.env.REVIEW_MODEL_CASCADE = "moonshotai/kimi-k2.7-code";
    process.env.POSTIL_API_BASE = "https://mock-upstream.test/v1";
    process.env.POSTIL_API_FORMAT = "openai-compatible";
    process.env.MODEL_API_KEY = "test-fixture-upstream-key";
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = "1";
    delete process.env.POSTIL_RELEASE_SHA;
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 4 });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminClient) {
      if (process.env.POSTIL_KEEP_TEST_DATABASE !== "1") {
        await adminClient.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      }
      await adminClient.end();
    }
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 30_000);

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.REVIEW_MODEL = "z-ai/glm-5.2";
    process.env.REVIEW_MODEL_CASCADE = "moonshotai/kimi-k2.7-code";
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = "1";
    delete process.env.POSTIL_RELEASE_SHA;
  });

  async function createOrgWithHostedEntitlement(): Promise<number> {
    orgCounter += 1;
    const slug = `cli-gateway-org-${process.pid}-${orgCounter}`;
    const org = await pool!.query<{ id: string }>(
      `INSERT INTO organizations (slug, name) VALUES ($1, $1) RETURNING id`,
      [slug],
    );
    const orgId = Number(org.rows[0]?.id);
    await pool!.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [orgId, userId],
    );
    await pool!.query(
      `INSERT INTO organization_entitlements (
         org_id, subscription_mode, status, included_usage_micros,
         overage_hard_cap_micros, included_usage_cents, overage_hard_cap_cents, updated_by
       ) VALUES ($1, 'hosted', 'active', 5000000, 0, 500, 0, 'test')`,
      [orgId],
    );
    return orgId;
  }

  async function createOrgWithoutEntitlement(): Promise<number> {
    orgCounter += 1;
    const slug = `cli-gateway-no-entitlement-${process.pid}-${orgCounter}`;
    const org = await pool!.query<{ id: string }>(
      `INSERT INTO organizations (slug, name) VALUES ($1, $1) RETURNING id`,
      [slug],
    );
    const orgId = Number(org.rows[0]?.id);
    await pool!.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [orgId, userId],
    );
    return orgId;
  }

  async function issueCliToken(
    orgId: number,
    opts: { revoked?: boolean; expiresAt?: Date } = {},
  ): Promise<string> {
    const token = `pcli_${Buffer.from(`fixture-${orgId}-${Math.random()}`).toString("base64url").padEnd(43, "a").slice(0, 43)}`;
    const expiresAt =
      opts.expiresAt ?? new Date(Date.now() + 12 * 60 * 60 * 1_000);
    await pool!.query(
      `INSERT INTO cli_tokens (token_sha256, user_id, org_id, scope, expires_at, revoked_at)
       VALUES ($1, $2, $3, 'inference', $4, $5)`,
      [
        sha256(token),
        userId,
        orgId,
        expiresAt,
        opts.revoked ? new Date() : null,
      ],
    );
    return token;
  }

  function chatRequest(token: string | undefined, body: unknown): Request {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    return new Request("https://postil.dev/api/inference/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  function mockUpstreamSuccess(promptTokens = 100, completionTokens = 20) {
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-fixture",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
  }

  test("rejects an unknown, revoked, or expired token with 401", async () => {
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const revokedToken = await issueCliToken(orgId, { revoked: true });
    const expiredToken = await issueCliToken(orgId, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    for (const token of [
      "pcli_" + "a".repeat(43),
      revokedToken,
      expiredToken,
    ]) {
      const response = await POST(chatRequest(token, { messages: [] }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { message: "postil login required", type: "invalid_token" },
      });
    }

    const missingAuth = await POST(chatRequest(undefined, { messages: [] }));
    expect(missingAuth.status).toBe(401);
  });

  test("returns 402 when the entitlement denies", async () => {
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithoutEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, { messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("entitlement");
    expect(body.error.message).toBe("no_entitlement");
  });

  test("rejects a model outside the hosted roster with 400", async () => {
    mockUpstreamSuccess();
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, {
        model: "openai/definitely-not-on-the-roster",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_model");

    const reservations = await pool!.query<{ status: string }>(
      `SELECT status FROM hosted_usage_reservations WHERE org_id = $1 AND operation = 'cli_gateway'`,
      [orgId],
    );
    expect(reservations.rows.map((row) => row.status)).toEqual(["released"]);
  });

  test("forwards the pinned CLI default when the environment roster is empty", async () => {
    delete process.env.REVIEW_MODEL;
    delete process.env.REVIEW_MODEL_CASCADE;
    let forwardedModel: unknown;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwardedModel = JSON.parse(String(init?.body)).model;
        return new Response(JSON.stringify({
          id: "chatcmpl-pinned-default",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const { POST } = await import("@/app/api/inference/v1/chat/completions/route");
    const { resolveHostedGatewayDefaultModel } = await import("@/lib/cli-gateway");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, { messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.status).toBe(200);
    expect(forwardedModel).toBe(release.hostedCliDefaultModel);
    expect(await resolveHostedGatewayDefaultModel(pool!)).toBe(release.hostedCliDefaultModel);
  });

  test("keeps the gateway and advertised model dark while hosted inference is unavailable", async () => {
    delete process.env.REVIEW_MODEL;
    delete process.env.REVIEW_MODEL_CASCADE;
    let upstreamCalled = false;
    globalThis.fetch = Object.assign(
      async () => {
        upstreamCalled = true;
        throw new Error("unavailable hosted inference must not call upstream");
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const { POST } = await import("@/app/api/inference/v1/chat/completions/route");
    const { resolveHostedGatewayDefaultModel } = await import("@/lib/cli-gateway");

    for (const [enabled, releaseSha] of [
      ["0", undefined],
      ["1", "c".repeat(40)],
    ] as const) {
      process.env.POSTIL_HOSTED_INFERENCE_ENABLED = enabled;
      if (releaseSha === undefined) delete process.env.POSTIL_RELEASE_SHA;
      else process.env.POSTIL_RELEASE_SHA = releaseSha;
      const orgId = await createOrgWithHostedEntitlement();
      const token = await issueCliToken(orgId);

      const response = await POST(
        chatRequest(token, { messages: [{ role: "user", content: "hi" }] }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { message: "hosted inference is unavailable", type: "unavailable" },
      });
      expect(await resolveHostedGatewayDefaultModel(pool!)).toBeNull();
      const reservations = await pool!.query(
        `SELECT 1 FROM hosted_usage_reservations WHERE org_id = $1`,
        [orgId],
      );
      expect(reservations.rows).toHaveLength(0);
    }
    expect(upstreamCalled).toBe(false);
  });

  test("rejects stream: true with 400 without ever calling upstream", async () => {
    let upstreamCalled = false;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        upstreamCalled = true;
        throw new Error("upstream must not be called for a streaming request");
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, {
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "streaming is not supported by the CLI gateway",
        type: "unsupported",
      },
    });
    expect(upstreamCalled).toBe(false);
  });

  test("a successful call records a private_hosted usage_events row and reconciles the reservation", async () => {
    mockUpstreamSuccess(120, 30);
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, { messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      usage: { prompt_tokens: number };
    };
    expect(body.usage.prompt_tokens).toBe(120);

    const usage = await pool!.query<{
      billing_scope: string;
      trigger_source: string;
      repository_id: number | null;
      review_id: number | null;
      prompt_tokens: number;
      completion_tokens: number;
    }>(
      `SELECT billing_scope, trigger_source, repository_id, review_id, prompt_tokens, completion_tokens
       FROM usage_events WHERE org_id = $1`,
      [orgId],
    );
    expect(usage.rows).toEqual([
      {
        billing_scope: "private_hosted",
        trigger_source: "unknown",
        repository_id: null,
        review_id: null,
        prompt_tokens: 120,
        completion_tokens: 30,
      },
    ]);

    const reservations = await pool!.query<{
      status: string;
      operation: string;
    }>(
      `SELECT status, operation FROM hosted_usage_reservations WHERE org_id = $1`,
      [orgId],
    );
    expect(reservations.rows).toEqual([
      { status: "reconciled", operation: "cli_gateway" },
    ]);
  });

  test("an upstream failure releases the reservation instead of charging", async () => {
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new Error("simulated upstream network failure");
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, { messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("upstream_error");

    const reservations = await pool!.query<{ status: string }>(
      `SELECT status FROM hosted_usage_reservations WHERE org_id = $1`,
      [orgId],
    );
    expect(reservations.rows).toEqual([{ status: "released" }]);
    const usage = await pool!.query(
      `SELECT 1 FROM usage_events WHERE org_id = $1`,
      [orgId],
    );
    expect(usage.rows).toHaveLength(0);
  });

  test("returns 429 with retry-after once the per-org hourly cap is reached", async () => {
    process.env.POSTIL_CLI_GATEWAY_HOURLY_CAP = "1";
    mockUpstreamSuccess();
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const first = await POST(
      chatRequest(token, { messages: [{ role: "user", content: "hi" }] }),
    );
    expect(first.status).toBe(200);

    const second = await POST(
      chatRequest(token, { messages: [{ role: "user", content: "hi" }] }),
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    const body = (await second.json()) as { error: { type: string } };
    expect(body.error.type).toBe("rate_limited");

    delete process.env.POSTIL_CLI_GATEWAY_HOURLY_CAP;
  });
});
