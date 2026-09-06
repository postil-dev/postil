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
  REVIEW_REASONING_EFFORT: process.env.REVIEW_REASONING_EFFORT,
  REVIEW_SCORER_REASONING_EFFORT: process.env.REVIEW_SCORER_REASONING_EFFORT,
  POSTIL_API_BASE: process.env.POSTIL_API_BASE,
  POSTIL_API_FORMAT: process.env.POSTIL_API_FORMAT,
  POSTIL_ENDPOINT_AUTH_HEADER: process.env.POSTIL_ENDPOINT_AUTH_HEADER,
  POSTIL_ENDPOINT_AUTH_VALUE: process.env.POSTIL_ENDPOINT_AUTH_VALUE,
  POSTIL_MANAGED_RELEASE: process.env.POSTIL_MANAGED_RELEASE,
  MODEL_API_KEY: process.env.MODEL_API_KEY,
  POSTIL_CLI_GATEWAY_HOURLY_CAP: process.env.POSTIL_CLI_GATEWAY_HOURLY_CAP,
  POSTIL_HOSTED_INFERENCE_ENABLED: process.env.POSTIL_HOSTED_INFERENCE_ENABLED,
  POSTIL_PROVISIONAL_HOSTED_ROSTER: process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER,
  POSTIL_RELEASE_SHA: process.env.POSTIL_RELEASE_SHA,
};

test("resolves and applies the complete managed gateway policy", async () => {
  const {
    buildManagedHostedChatCompletionRequest,
    resolveManagedHostedProviderProfile,
  } = await import("@/lib/managed-hosted-provider-profile");
  const profile = resolveManagedHostedProviderProfile({
    POSTIL_PROVISIONAL_HOSTED_ROSTER: "1",
  });
  expect(profile).toEqual({
    apiBase: "https://openrouter.ai/api/v1",
    apiFormat: "openai-compatible",
    model: "openai/gpt-5.6-luna",
    providerName: "Azure",
    providerRoute: "azure/eu",
    reasoningEffort: "low",
    maxOutputTokens: 8000,
    temperature: 0.1,
    maxPromptPrice: 0.22,
    maxCompletionPrice: 1.32,
  });
  expect(
    buildManagedHostedChatCompletionRequest(
      {
        model: "client/model",
        models: ["client/fallback"],
        reasoning: { effort: "max" },
        provider: { order: ["client-provider"] },
        route: "client-provider",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: "review" }],
        max_tokens: 200_000,
        temperature: 0,
      },
      profile,
    ),
  ).toEqual({
    messages: [{ role: "user", content: "review" }],
    max_tokens: 8000,
    temperature: 0.1,
    model: "openai/gpt-5.6-luna",
    reasoning: { effort: "low" },
    provider: {
      data_collection: "deny",
      zdr: true,
      order: ["azure/eu"],
      allow_fallbacks: false,
      max_price: {
        prompt: 0.22,
        completion: 1.32,
      },
    },
  });
});

test("rejects drift from the managed gateway profile", async () => {
  const { resolveManagedHostedProviderProfile } =
    await import("@/lib/managed-hosted-provider-profile");
  for (const environment of [
    {},
    {
      POSTIL_PROVISIONAL_HOSTED_ROSTER: "1",
      REVIEW_MODEL: "z-ai/glm-5.2",
    },
    {
      POSTIL_PROVISIONAL_HOSTED_ROSTER: "1",
      REVIEW_MODEL_CASCADE: "attacker/fallback",
    },
    {
      POSTIL_PROVISIONAL_HOSTED_ROSTER: "1",
      REVIEW_REASONING_EFFORT: "high",
    },
    {
      POSTIL_PROVISIONAL_HOSTED_ROSTER: "1",
      POSTIL_API_BASE: "https://provider.example/v1",
    },
    {
      POSTIL_PROVISIONAL_HOSTED_ROSTER: "1",
      POSTIL_API_FORMAT: "anthropic",
    },
  ]) {
    expect(() => resolveManagedHostedProviderProfile(environment)).toThrow();
  }
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
    delete process.env.REVIEW_MODEL;
    delete process.env.REVIEW_MODEL_CASCADE;
    process.env.REVIEW_REASONING_EFFORT = "low";
    delete process.env.REVIEW_SCORER_REASONING_EFFORT;
    delete process.env.POSTIL_MANAGED_RELEASE;
    delete process.env.POSTIL_ENDPOINT_AUTH_HEADER;
    delete process.env.POSTIL_ENDPOINT_AUTH_VALUE;
    process.env.POSTIL_API_BASE = "https://openrouter.ai/api/v1";
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
    delete process.env.REVIEW_MODEL;
    delete process.env.REVIEW_MODEL_CASCADE;
    process.env.REVIEW_REASONING_EFFORT = "low";
    delete process.env.REVIEW_SCORER_REASONING_EFFORT;
    delete process.env.POSTIL_MANAGED_RELEASE;
    delete process.env.POSTIL_ENDPOINT_AUTH_HEADER;
    delete process.env.POSTIL_ENDPOINT_AUTH_VALUE;
    process.env.POSTIL_API_BASE = "https://openrouter.ai/api/v1";
    process.env.POSTIL_API_FORMAT = "openai-compatible";
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
          model: release.hostedCliDefaultModel,
          provider: "Azure",
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

  test("managed gateways never forward additional endpoint credentials", async () => {
    process.env.POSTIL_MANAGED_RELEASE = "1";
    process.env.POSTIL_ENDPOINT_AUTH_HEADER = "x-provider-auth";
    const endpointCredential = "fixture-managed-endpoint-auth-not-a-real-credential";
    process.env.POSTIL_ENDPOINT_AUTH_VALUE = endpointCredential;
    mockUpstreamSuccess();
    const respond = globalThis.fetch;
    let forwardedHeaders: Headers | undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        forwardedHeaders = new Headers(init?.headers);
        return respond(input, init);
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const { POST } = await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);
    const response = await POST(chatRequest(token, { messages: [] }));

    expect(response.status).toBe(200);
    expect(forwardedHeaders?.get("x-provider-auth")).toBeNull();
    expect(Array.from(forwardedHeaders!.values())).not.toContain(endpointCredential);
    expect(forwardedHeaders?.get("authorization")).toBe("Bearer test-fixture-upstream-key");
  });

  test("replaces client model, reasoning, and provider routing with hosted policy", async () => {
    let forwardedBody: Record<string, unknown> | undefined;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwardedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-hosted-policy",
            object: "chat.completion",
            model: release.hostedCliDefaultModel,
            provider: "Azure",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, {
        model: "attacker/expensive",
        models: ["attacker/fallback"],
        reasoning: { effort: "max" },
        provider: { order: ["attacker"], allow_fallbacks: true },
        route: "attacker",
        max_tokens: 200_000,
        temperature: 0,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.status).toBe(200);
    expect(forwardedBody).toEqual({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8000,
      temperature: 0.1,
      model: release.hostedCliDefaultModel,
      reasoning: { effort: "low" },
      provider: {
        data_collection: "deny",
        zdr: true,
        order: ["azure/eu"],
        allow_fallbacks: false,
        max_price: { prompt: 0.22, completion: 1.32 },
      },
    });
    const responseBody = (await response.json()) as { model: string };
    expect(responseBody.model).toBe(release.hostedCliDefaultModel);
    const usage = await pool!.query<{ model_used: string }>(
      `SELECT model_used FROM usage_events WHERE org_id = $1`,
      [orgId],
    );
    expect(usage.rows).toEqual([{ model_used: release.hostedCliDefaultModel }]);
  });

  test("accounts the returned model and rejects an upstream identity mismatch", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-model-mismatch",
            object: "chat.completion",
            model: "upstream/unexpected-model",
            provider: "Unexpected Provider",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, {
        model: release.hostedCliDefaultModel,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        message: "the upstream response identity did not match the hosted provider policy",
        type: "upstream_identity_mismatch",
      },
    });
    const usage = await pool!.query<{
      model_used: string;
      prompt_tokens: number;
      completion_tokens: number;
      cost_micros: string | null;
    }>(
      `SELECT model_used, prompt_tokens, completion_tokens, cost_micros
       FROM usage_events WHERE org_id = $1`,
      [orgId],
    );
    expect(usage.rows).toHaveLength(2);
    expect(usage.rows).toContainEqual({
      model_used: "upstream/unexpected-model",
      prompt_tokens: 10,
      completion_tokens: 2,
      cost_micros: "0",
    });
    expect(usage.rows).toContainEqual({
      model_used: "unattributed provider usage",
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_micros: "1000000",
    });
    const reservations = await pool!.query<{ status: string }>(
      `SELECT status FROM hosted_usage_reservations WHERE org_id = $1 AND operation = 'cli_gateway'`,
      [orgId],
    );
    expect(reservations.rows.map((row) => row.status)).toEqual(["reconciled"]);
  });

  test("rejects an unexpected returned provider with complete usage accounting", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-provider-mismatch",
            object: "chat.completion",
            model: release.hostedCliDefaultModel,
            provider: "Unexpected Provider",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const { POST } =
      await import("@/app/api/inference/v1/chat/completions/route");
    const orgId = await createOrgWithHostedEntitlement();
    const token = await issueCliToken(orgId);

    const response = await POST(
      chatRequest(token, {
        model: release.hostedCliDefaultModel,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        message: "the upstream response identity did not match the hosted provider policy",
        type: "upstream_identity_mismatch",
      },
    });
    const usage = await pool!.query<{
      model_used: string;
      prompt_tokens: number;
      completion_tokens: number;
      cost_micros: string;
    }>(
      `SELECT model_used, prompt_tokens, completion_tokens, cost_micros
       FROM usage_events WHERE org_id = $1`,
      [orgId],
    );
    expect(usage.rows).toEqual([{
      model_used: release.hostedCliDefaultModel,
      prompt_tokens: 10,
      completion_tokens: 2,
      cost_micros: "5",
    }]);
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
          model: release.hostedCliDefaultModel,
          provider: "Azure",
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

  test("nonmanaged gateways select the server default and preserve legacy upstream responses", async () => {
    delete process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER;
    process.env.POSTIL_MANAGED_RELEASE = "0";
    process.env.REVIEW_MODEL = "server/default";
    process.env.REVIEW_MODEL_CASCADE = "server/expensive-fallback";
    process.env.REVIEW_REASONING_EFFORT = "medium";
    process.env.POSTIL_API_BASE = "https://provider.example/v1/";
    process.env.POSTIL_ENDPOINT_AUTH_HEADER = "x-provider-auth";
    process.env.POSTIL_ENDPOINT_AUTH_VALUE = "server-fixture-auth";
    const { POST } = await import("@/app/api/inference/v1/chat/completions/route");
    const { resolveHostedGatewayDefaultModel } = await import("@/lib/cli-gateway");
    expect(await resolveHostedGatewayDefaultModel(pool!)).toBe("server/default");

    for (const returnedModel of [undefined, release.hostedCliDefaultModel]) {
      const upstreamBody = {
        ...(returnedModel ? { model: returnedModel } : {}),
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      };
      let forwardedBody: unknown;
      let forwardedUrl: unknown;
      let forwardedHeaders: Headers | undefined;
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          forwardedUrl = input;
          forwardedBody = JSON.parse(String(init?.body));
          forwardedHeaders = new Headers(init?.headers);
          return Response.json(upstreamBody);
        },
        { preconnect: ORIGINAL_FETCH.preconnect },
      ) as typeof fetch;
      const orgId = await createOrgWithHostedEntitlement();
      const token = await issueCliToken(orgId);
      const messages = [{ role: "user", content: "review" }];
      const response = await POST(chatRequest(token, {
        model: "server/expensive-fallback",
        models: ["client/model"],
        reasoning: { effort: "max", max_tokens: 200_000 },
        reasoning_effort: "max",
        provider: { order: ["client/provider"] },
        route: "client/route",
        response_format: { type: "json_object" },
        max_tokens: 200_000,
        temperature: 2,
        unknown_routing_field: true,
        messages,
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(upstreamBody);
      expect(forwardedUrl).toBe("https://provider.example/v1/chat/completions");
      expect(forwardedHeaders?.get("x-provider-auth")).toBe("server-fixture-auth");
      expect(forwardedBody).toEqual({
        messages,
        model: "server/default",
        reasoning: { effort: "medium" },
        max_tokens: 8_000,
        temperature: 0.1,
      });
      const usage = await pool!.query(
        `SELECT model_used, prompt_tokens, completion_tokens, cost_micros
         FROM usage_events WHERE org_id = $1 AND prompt_tokens > 0`,
        [orgId],
      );
      expect(usage.rows).toEqual([{
        model_used: returnedModel ?? "server/default",
        prompt_tokens: 10,
        completion_tokens: 2,
        cost_micros: returnedModel ? "5" : "0",
      }]);
    }
  });

  test("nonmanaged login uses the first configured cascade entry when no default is set", async () => {
    delete process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER;
    process.env.REVIEW_MODEL_CASCADE = " , server/first,server/second";
    const { resolveHostedGatewayDefaultModel } = await import("@/lib/cli-gateway");
    expect(await resolveHostedGatewayDefaultModel(pool!)).toBe("server/first");
    delete process.env.REVIEW_MODEL_CASCADE;
    expect(await resolveHostedGatewayDefaultModel(pool!)).toBeNull();
  });

  test("managed gateways fail closed without provisional admission before reserving spend", async () => {
    process.env.POSTIL_MANAGED_RELEASE = "1";
    process.env.REVIEW_MODEL = release.hostedCliDefaultModel;
    let upstreamCalled = false;
    globalThis.fetch = Object.assign(async () => {
      upstreamCalled = true;
      return Response.json({});
    }, { preconnect: ORIGINAL_FETCH.preconnect }) as typeof fetch;
    const { POST } = await import("@/app/api/inference/v1/chat/completions/route");
    const { resolveHostedGatewayDefaultModel } = await import("@/lib/cli-gateway");
    for (const provisional of [undefined, "0"]) {
      if (provisional === undefined) delete process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER;
      else process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = provisional;
      const orgId = await createOrgWithHostedEntitlement();
      const token = await issueCliToken(orgId);
      const response = await POST(chatRequest(token, { messages: [] }));
      expect(response.status).toBe(503);
      expect(await resolveHostedGatewayDefaultModel(pool!)).toBeNull();
      const reservations = await pool!.query(
        `SELECT 1 FROM hosted_usage_reservations WHERE org_id = $1`, [orgId],
      );
      expect(reservations.rows).toHaveLength(0);
    }
    expect(upstreamCalled).toBe(false);
  });

  test("managed responses still require both model and provider identity", async () => {
    const { POST } = await import("@/app/api/inference/v1/chat/completions/route");
    for (const identity of [{ model: release.hostedCliDefaultModel }, { provider: "Azure" }]) {
      globalThis.fetch = Object.assign(async () => Response.json({
        ...identity,
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { preconnect: ORIGINAL_FETCH.preconnect }) as typeof fetch;
      const orgId = await createOrgWithHostedEntitlement();
      const token = await issueCliToken(orgId);
      const response = await POST(chatRequest(token, { messages: [] }));
      expect(response.status).toBe(502);
      expect((await response.json()).error.type).toBe("upstream_identity_mismatch");
    }
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
      model_used: string;
      cost_micros: string;
    }>(
      `SELECT billing_scope, trigger_source, repository_id, review_id, prompt_tokens,
              completion_tokens, model_used, cost_micros
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
        model_used: release.hostedCliDefaultModel,
        cost_micros: "60",
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
