import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  hashEffectiveReviewConfiguration,
  largeReviewAttemptKey,
  largeReviewRunKey,
  privateUpstreamAllowed,
  providerIdentity,
  startLargeReviewProviderProxy,
  type AttemptClaim,
  type LargeReviewAttemptStore,
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
