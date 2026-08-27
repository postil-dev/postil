import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  hashEffectiveReviewConfiguration,
  largeReviewAttemptKey,
  largeReviewRunKey,
  canonicalOpenRouterRequestHeaders,
  inspectOpenRouterFailure,
  openRouterFailureDiagnostics,
  privateUpstreamAllowed,
  providerIdentity,
  startLargeReviewProviderProxy,
  type AttemptClaim,
  type LargeReviewAttemptStore,
  type LargeReviewProviderDiagnostic,
  type LargeReviewRunContext,
  type LargeReviewRunIdentity,
  type StoredProviderResponse,
} from "@/lib/large-review-resume";
import { redactSecrets } from "@/lib/redact";

const PLAN_SHA = "a".repeat(64);
const HEAD_SHA = "b".repeat(40);
const BASE_SHA = "d".repeat(40);
const CONFIG_SHA = "c".repeat(64);
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const ipv6FirstLoopback = async () => [
  { address: "::1", family: 6 },
  { address: "127.0.0.1", family: 4 },
];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

class MemoryAttemptStore implements LargeReviewAttemptStore {
  readonly runs = new Map<string, LargeReviewRunIdentity>();
  readonly attempts = new Map<
    string,
    {
      runKey: string;
      requestSha256: string;
      leaseId: string;
      response?: StoredProviderResponse;
    }
  >();

  async bindRun(identity: LargeReviewRunIdentity, context: LargeReviewRunContext) {
    const key = largeReviewRunKey(identity);
    if (context.expectedRunKey && context.expectedRunKey !== key) {
      // A replanned retry retires the run the previous attempt registered.
      this.runs.delete(context.expectedRunKey);
      for (const [attemptKey, attempt] of this.attempts) {
        if (attempt.runKey === context.expectedRunKey) this.attempts.delete(attemptKey);
      }
    }
    this.runs.set(key, identity);
    return key;
  }

  async claimAttempt(
    input: Parameters<LargeReviewAttemptStore["claimAttempt"]>[0],
  ): Promise<AttemptClaim> {
    const replay = [...this.attempts.values()].find(
      (entry) =>
        entry.runKey === input.runKey &&
        entry.requestSha256 === input.requestSha256 &&
        entry.response,
    );
    if (replay?.response) return { kind: "replay", response: replay.response };
    const attemptKey = largeReviewAttemptKey(input);
    if (this.attempts.has(attemptKey)) return { kind: "pending" };
    const leaseId = crypto.randomUUID();
    this.attempts.set(attemptKey, {
      runKey: input.runKey,
      requestSha256: input.requestSha256,
      leaseId,
    });
    return { kind: "execute", attemptKey, leaseId };
  }

  async completeAttempt(input: Parameters<LargeReviewAttemptStore["completeAttempt"]>[0]) {
    const attempt = this.attempts.get(input.attemptKey);
    if (!attempt || attempt.leaseId !== input.leaseId) throw new Error("lost lease");
    attempt.response = input.response;
  }

  async abandonAttempt(attemptKey: string, leaseId: string) {
    if (this.attempts.get(attemptKey)?.leaseId === leaseId) {
      this.attempts.delete(attemptKey);
    }
  }

  async deleteRun(runKey: string) {
    this.runs.delete(runKey);
    for (const [key, attempt] of this.attempts) {
      if (attempt.runKey === runKey) this.attempts.delete(key);
    }
  }
}

class FailingCompleteAttemptStore extends MemoryAttemptStore {
  override async completeAttempt(
    _input: Parameters<LargeReviewAttemptStore["completeAttempt"]>[0],
  ): Promise<void> {
    throw new Error("test persistence failure");
  }
}

function proxySeed(upstreamApiBase: string) {
  return {
    upstreamApiBase,
    apiFormat: "openai-compatible" as const,
    allowPrivateUpstream: true,
    identity: {
      repositoryId: 17,
      prNumber: 9,
      cliVersion: "0.8.0",
      configurationSha256: CONFIG_SHA,
      providerIdentity: providerIdentity({
        apiBase: upstreamApiBase,
        apiFormat: "openai-compatible",
        byok: false,
        apiKey: "provider-key",
        identityKey: "identity-key",
      }),
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      retryLineage: "review-job:31",
    },
    runContext: { currentReviewId: 1, hostedReservationId: null },
  };
}

const plan = {
  version: 1,
  planSha256: PLAN_SHA,
  directHunks: 4,
  semanticHunks: 2,
  unreviewedHunks: 0,
  selectedBatches: 3,
  totalBatches: 3,
  concurrency: 2,
  requestTimeoutSeconds: 60,
  reviewBudgetSeconds: 420,
};

async function register(
  proxy: Awaited<ReturnType<typeof startLargeReviewProviderProxy>>,
  overrides = {},
) {
  return fetch(proxy.planEndpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.planToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...plan, ...overrides }),
  });
}

const requestBody = JSON.stringify({
  model: "openai/test-model",
  messages: [{ role: "user", content: "review batch 4" }],
});
const successfulBody = JSON.stringify({
  choices: [{ message: { role: "assistant", content: '{"findings":[]}' } }],
  usage: { prompt_tokens: 23, completion_tokens: 5 },
});

describe("durable large-review provider proxy", () => {
  test("uses the canonical OpenRouter metadata header", () => {
    const forwarded = canonicalOpenRouterRequestHeaders(
      new Headers({
        authorization: "Bearer request-token",
        "x-openrouter-experimental-metadata": "enabled",
        "x-openrouter-metadata": "disabled",
      }),
    );
    expect(forwarded.get("x-openrouter-metadata")).toBe("enabled");
    expect(forwarded.get("x-openrouter-experimental-metadata")).toBeNull();
    expect(forwarded.get("authorization")).toBe("Bearer request-token");
  });

  test("extracts ordered attempts from every supported upstream failure status", () => {
    const error = { error: { type: "provider_error", message: "unavailable" } };
    const body = JSON.stringify({
      ...error,
      openrouter_metadata: {
        attempts: [
          { provider: " Azure ", status: 503 },
          { provider: "Novita", status: 200 },
        ],
        region: "discarded",
      },
    });
    for (const status of [502, 503, 504, 529]) {
      const inspection = inspectOpenRouterFailure({
        isCanonicalOpenRouter: true,
        status,
        body,
      });
      expect(inspection.attempts).toEqual([
        { ordinal: 1, provider: "Azure", status: 503 },
        { ordinal: 2, provider: "Novita", status: 200 },
      ]);
      expect(JSON.parse(inspection.body)).toEqual(error);
    }

    const diagnostics = openRouterFailureDiagnostics({
      isCanonicalOpenRouter: true,
      status: 503,
      body,
      reviewId: 42,
      requestSha256: "f".repeat(64),
    });
    expect(diagnostics.diagnostics).toEqual([
      {
        event: "postil.large_review.provider_failure",
        source: "upstream",
        review_id: 42,
        request_sha256: "f".repeat(64),
        upstream_status: 503,
        attempt_ordinal: 1,
        provider: "Azure",
        attempted_status: 503,
      },
      {
        event: "postil.large_review.provider_failure",
        source: "upstream",
        review_id: 42,
        request_sha256: "f".repeat(64),
        upstream_status: 503,
        attempt_ordinal: 2,
        provider: "Novita",
        attempted_status: 200,
      },
    ]);
  });

  test("filters malformed attempts and provider labels without forwarding metadata", () => {
    const body = JSON.stringify({
      error: { type: "provider_error" },
      preserved: "value",
      openrouter_metadata: {
        attempts: [
          { provider: " Azure ", status: 503 },
          { provider: "bad\nprovider", status: 200 },
          { provider: "https://provider.example", status: 200 },
          { provider: "www.provider.example", status: 200 },
          { provider: ["sk", "live-123456789012"].join("-"), status: 200 },
          {
            provider: [
              "eyJhbGciOiJIUzI1NiJ9",
              "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
              "signature-part-is-long",
            ].join("."),
            status: 200,
          },
          { provider: "a".repeat(81), status: 200 },
          { provider: "Novita", status: "200" },
          { provider: "Novita", status: 99 },
          { provider: "Novita", status: 600 },
          { provider: "Z.AI", status: 429 },
        ],
        extra: "ignored",
      },
    });
    const inspection = inspectOpenRouterFailure({
      isCanonicalOpenRouter: true,
      status: 503,
      body,
    });
    expect(inspection.attempts).toEqual([
      { ordinal: 1, provider: "Azure", status: 503 },
    ]);
    expect(JSON.parse(inspection.body)).toEqual({
      error: { type: "provider_error" },
      preserved: "value",
    });

    expect(
      inspectOpenRouterFailure({
        isCanonicalOpenRouter: true,
        status: 503,
        body: JSON.stringify({
          error: { type: "provider_error" },
          openrouter_metadata: { attempts: "malformed" },
        }),
      }),
    ).toMatchObject({
      attempts: [],
      body: JSON.stringify({ error: { type: "provider_error" } }),
    });
    expect(
      inspectOpenRouterFailure({
        isCanonicalOpenRouter: true,
        status: 503,
        body: "not-json",
      }),
    ).toEqual({ body: "not-json", attempts: [] });
  });

  test("caps valid provider attempts at eight while preserving order", () => {
    const inspection = inspectOpenRouterFailure({
      isCanonicalOpenRouter: true,
      status: 504,
      body: JSON.stringify({
        error: { type: "provider_error" },
        openrouter_metadata: {
          attempts: Array.from({ length: 10 }, (_, index) => ({
            provider: `Provider ${index + 1}`,
            status: 500 + index,
          })),
        },
      }),
    });
    expect(inspection.attempts).toHaveLength(8);
    expect(inspection.attempts[0]).toEqual({
      ordinal: 1,
      provider: "Provider 1",
      status: 500,
    });
    expect(inspection.attempts[7]).toEqual({
      ordinal: 8,
      provider: "Provider 8",
      status: 507,
    });

    const malformedFirst = inspectOpenRouterFailure({
      isCanonicalOpenRouter: true,
      status: 503,
      body: JSON.stringify({
        error: { type: "provider_error" },
        openrouter_metadata: {
          attempts: [
            { provider: "bad\nprovider", status: 503 },
            ...Array.from({ length: 8 }, (_, index) => ({
              provider: `Provider ${index + 1}`,
              status: 500 + index,
            })),
          ],
        },
      }),
    });
    expect(malformedFirst.attempts).toHaveLength(7);
    expect(malformedFirst.attempts[0]).toEqual({
      ordinal: 2,
      provider: "Provider 1",
      status: 500,
    });
    expect(malformedFirst.attempts[6]).toEqual({
      ordinal: 8,
      provider: "Provider 7",
      status: 506,
    });
  });

  test("does not inspect non-OpenRouter BYOK failures", () => {
    const body = JSON.stringify({
      error: { type: "provider_error" },
      openrouter_metadata: { attempts: [{ provider: "Azure", status: 503 }] },
    });
    expect(
      inspectOpenRouterFailure({
        isCanonicalOpenRouter: false,
        status: 503,
        body,
      }),
    ).toEqual({ body, attempts: [] });
  });

  test("labels a gateway-created 502 as gateway instead of upstream", async () => {
    const unreachable = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, { status: 204 });
      },
    });
    const port = unreachable.port;
    unreachable.stop(true);
    const diagnostics: LargeReviewProviderDiagnostic[] = [];
    const proxy = await startLargeReviewProviderProxy({
      ...proxySeed(`http://127.0.0.1:${port}/v1`),
      store: new MemoryAttemptStore(),
      operatorLog: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect((await register(proxy)).status).toBe(204);
    const response = await fetch(`${proxy.apiBase}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });
    expect(response.status).toBe(502);
    expect(diagnostics).toEqual([
      {
        event: "postil.large_review.provider_failure",
        source: "gateway",
        review_id: 1,
        request_sha256: expect.any(String),
        gateway_status: 502,
        request_attempt: 1,
      },
    ]);
    proxy.close();
  });

  test("labels a gateway-created 503 as gateway instead of upstream", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(successfulBody);
      },
    });
    servers.push(upstream);
    const diagnostics: LargeReviewProviderDiagnostic[] = [];
    const proxy = await startLargeReviewProviderProxy({
      ...proxySeed(`http://127.0.0.1:${upstream.port}/v1`),
      store: new FailingCompleteAttemptStore(),
      operatorLog: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect((await register(proxy)).status).toBe(204);
    const response = await fetch(`${proxy.apiBase}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });
    expect(response.status).toBe(503);
    expect(diagnostics).toEqual([
      {
        event: "postil.large_review.provider_failure",
        source: "gateway",
        review_id: 1,
        request_sha256: expect.any(String),
        gateway_status: 503,
        request_attempt: 1,
      },
    ]);
    proxy.close();
  });

  test("requires authenticated plan registration and uses the validated address set", async () => {
    let providerCalls = 0;
    let resolutions = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        providerCalls += 1;
        return new Response(successfulBody, {
          headers: { "x-request-id": "req-1" },
        });
      },
    });
    servers.push(upstream);
    const store = new MemoryAttemptStore();
    const proxy = await startLargeReviewProviderProxy({
      ...proxySeed(`http://localhost:${upstream.port}/v1`),
      resolveHostname: async () => {
        resolutions += 1;
        return ipv6FirstLoopback();
      },
      store,
    });
    const early = await fetch(`${proxy.apiBase}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });
    expect(early.status).toBe(428);
    expect(providerCalls).toBe(0);
    expect(
      (
        await fetch(proxy.planEndpoint, {
          method: "POST",
          body: JSON.stringify(plan),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(proxy.planEndpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${proxy.planToken}` },
          body: "x".repeat(16 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    expect((await register(proxy)).status).toBe(204);
    expect((await register(proxy)).status).toBe(204);
    expect((await register(proxy, { planSha256: "f".repeat(64) })).status).toBe(409);

    for (let batch = 4; batch <= 6; batch += 1) {
      const response = await fetch(`${proxy.apiBase}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/test-model",
          messages: [{ role: "user", content: `review batch ${batch}` }],
        }),
      });
      expect(await response.text()).toBe(successfulBody);
    }
    expect(providerCalls).toBe(3);
    expect(resolutions).toBe(1);
    expect(proxy.billingOutcome()).toBe("resumable");
    expect(
      redactSecrets(
        `${proxy.apiBase} ${proxy.planEndpoint} ${proxy.planToken}`,
        [...proxy.redactionValues],
      ),
    ).not.toContain(proxy.planToken);
    expect(
      redactSecrets(proxy.apiBase, [...proxy.redactionValues]),
    ).not.toContain(new URL(proxy.apiBase).pathname.slice(1));
    proxy.close();
  });

  test("replays a completed response only under the same registered identity", async () => {
    let providerCalls = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        providerCalls += 1;
        return new Response(successfulBody);
      },
    });
    servers.push(upstream);
    const seed = proxySeed(`http://localhost:${upstream.port}/v1`);
    const store = new MemoryAttemptStore();
    const first = await startLargeReviewProviderProxy({
      ...seed,
      resolveHostname: ipv6FirstLoopback,
      store,
    });
    expect((await register(first)).status).toBe(204);
    await fetch(`${first.apiBase}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });
    first.close();

    const resumed = await startLargeReviewProviderProxy({
      ...seed,
      resolveHostname: ipv6FirstLoopback,
      store,
    });
    expect((await register(resumed)).status).toBe(204);
    expect(
      (
        await fetch(`${resumed.apiBase}/chat/completions`, {
          method: "POST",
          body: requestBody,
        })
      ).status,
    ).toBe(200);
    expect(providerCalls).toBe(1);
    await resumed.discardCompletedRun();
    resumed.close();
  });

  test("marks a truncated response body ambiguous", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"choices":[');
      response.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server address unavailable");
    }
    const proxy = await startLargeReviewProviderProxy({
      ...proxySeed(`http://localhost:${address.port}/v1`),
      store: new MemoryAttemptStore(),
    });
    expect((await register(proxy)).status).toBe(204);
    const response = await fetch(`${proxy.apiBase}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });
    expect(response.status).toBe(502);
    expect(proxy.billingOutcome()).toBe("ambiguous");
    proxy.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("stops a chunked provider response at the byte limit", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
      },
    });
    servers.push(upstream);
    const proxy = await startLargeReviewProviderProxy({
      ...proxySeed(`http://localhost:${upstream.port}/v1`),
      store: new MemoryAttemptStore(),
    });
    expect((await register(proxy)).status).toBe(204);
    const response = await fetch(`${proxy.apiBase}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });
    expect(response.status).toBe(502);
    expect(proxy.billingOutcome()).toBe("ambiguous");
    proxy.close();
  });

  test("pins the validated upstream address for the provider connection", async () => {
    let resolutions = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(successfulBody);
      },
    });
    servers.push(upstream);
    const proxy = await startLargeReviewProviderProxy({
      ...proxySeed(`http://provider.example:${upstream.port}/v1`),
      resolveHostname: async () => {
        resolutions += 1;
        return [{ address: "127.0.0.1", family: 4 }];
      },
      store: new MemoryAttemptStore(),
    });
    expect((await register(proxy)).status).toBe(204);
    expect(
      (
        await fetch(`${proxy.apiBase}/chat/completions`, {
          method: "POST",
          body: requestBody,
        })
      ).status,
    ).toBe(200);
    expect(resolutions).toBe(1);
    proxy.close();
  });

  test("binds endpoint query and keyed auth context without storing credentials", () => {
    const identity = (apiKey: string, query: string) =>
      providerIdentity({
        apiBase: `https://example.test/v1?tenant=${query}`,
        apiFormat: "openai-compatible",
        byok: true,
        apiKey,
        apiAuthHeader: "x-tenant-auth",
        apiAuthValue: "gateway-secret",
        identityKey: "identity-key",
      });
    expect(identity("key-a", "one")).not.toBe(identity("key-b", "one"));
    expect(identity("key-a", "one")).not.toBe(identity("key-a", "two"));
    expect(identity("key-a", "one")).not.toContain("key-a");
    expect(identity("key-a", "one")).not.toContain("gateway-secret");
  });

  test("never applies the process private-endpoint opt-in to BYOK upstreams", async () => {
    expect(
      privateUpstreamAllowed({ byok: false, configuredOptIn: "1" }),
    ).toBe(true);
    expect(
      privateUpstreamAllowed({ byok: true, configuredOptIn: "1" }),
    ).toBe(false);
    await expect(
      startLargeReviewProviderProxy({
        ...proxySeed("http://127.0.0.1:9/v1"),
        allowPrivateUpstream: false,
        store: new MemoryAttemptStore(),
      }),
    ).rejects.toThrow("explicitly allowed private endpoint");
  });

  test("hashes effective file labels and bytes deterministically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postil-large-review-config-"));
    try {
      await writeFile(join(dir, ".postil.yaml"), "enabled: true\n");
      const first = await hashEffectiveReviewConfiguration(dir, [
        "org:.postil.yaml",
      ]);
      expect(
        await hashEffectiveReviewConfiguration(dir, ["org:.postil.yaml"]),
      ).toBe(first);
      expect(
        await hashEffectiveReviewConfiguration(dir, [".postil.yaml"]),
      ).not.toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
