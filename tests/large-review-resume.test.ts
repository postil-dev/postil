import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  hashEffectiveReviewConfiguration,
  largeReviewAttemptKey,
  largeReviewRunKey,
  providerIdentity,
  startLargeReviewProviderProxy,
  type AttemptClaim,
  type LargeReviewAttemptStore,
  type LargeReviewRunContext,
  type LargeReviewRunIdentity,
  type StoredProviderResponse,
} from "@/lib/large-review-resume";

const PLAN_SHA = "a".repeat(64);
const HEAD_SHA = "b".repeat(40);
const CONFIG_SHA = "c".repeat(64);

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

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
      attempt: number;
      leaseId: string;
      response?: StoredProviderResponse;
    }
  >();
  bindGate: Promise<void> | undefined;

  async bindRun(
    identity: LargeReviewRunIdentity,
    _context: LargeReviewRunContext,
  ): Promise<string> {
    await this.bindGate;
    const key = largeReviewRunKey(identity);
    this.runs.set(key, identity);
    return key;
  }

  async claimAttempt(input: {
    runKey: string;
    requestSha256: string;
    batchIdentity: string;
    attempt: number;
    model: string;
  }): Promise<AttemptClaim> {
    const replay = [...this.attempts.values()].find(
      (entry) =>
        entry.runKey === input.runKey &&
        entry.requestSha256 === input.requestSha256 &&
        entry.response,
    );
    if (replay?.response) return { kind: "replay", response: replay.response };
    const attemptKey = largeReviewAttemptKey(input);
    const existing = this.attempts.get(attemptKey);
    if (existing) return { kind: "pending" };
    const leaseId = crypto.randomUUID();
    this.attempts.set(attemptKey, {
      runKey: input.runKey,
      requestSha256: input.requestSha256,
      attempt: input.attempt,
      leaseId,
    });
    return { kind: "execute", attemptKey, leaseId };
  }

  async completeAttempt(input: {
    attemptKey: string;
    leaseId: string;
    response: StoredProviderResponse;
  }): Promise<void> {
    const attempt = this.attempts.get(input.attemptKey);
    if (!attempt || attempt.leaseId !== input.leaseId) throw new Error("lost lease");
    attempt.response = input.response;
  }

  async abandonAttempt(attemptKey: string, leaseId: string): Promise<void> {
    const attempt = this.attempts.get(attemptKey);
    if (attempt?.leaseId === leaseId) this.attempts.delete(attemptKey);
  }

  async deleteRun(runKey: string): Promise<void> {
    this.runs.delete(runKey);
    for (const [key, attempt] of this.attempts) {
      if (attempt.runKey === runKey) this.attempts.delete(key);
    }
  }
}

function proxyIdentity(upstreamApiBase: string) {
  return {
    upstreamApiBase,
    apiFormat: "openai-compatible" as const,
    identity: {
      repositoryId: 17,
      cliVersion: "0.8.0",
      configurationSha256: CONFIG_SHA,
      providerIdentity: providerIdentity({
        apiBase: upstreamApiBase,
        apiFormat: "openai-compatible",
        byok: false,
      }),
      headSha: HEAD_SHA,
    },
    runContext: { currentReviewId: 1, hostedReservationId: null },
  };
}

function enableLargeReview(proxy: ReturnType<typeof startLargeReviewProviderProxy>) {
  proxy.observeCliStderr(
    `postil: deterministic large-review plan=${PLAN_SHA} direct_hunks=1`,
  );
  proxy.observeCliStderr(
    "postil: llm attempt phase=review model=test attempt=1/2 timeout=90s budget_remaining=420s",
  );
}

const requestBody = JSON.stringify({
  model: "openai/test-model",
  messages: [{ role: "user", content: "review batch 4" }],
});

const successfulBody = JSON.stringify({
  id: "response-1",
  choices: [{ message: { role: "assistant", content: '{"findings":[]}' } }],
  usage: { prompt_tokens: 23, completion_tokens: 5 },
});

describe("durable large-review provider proxy", () => {
  test("persists the plan before provider contact and replays a completed batch byte-for-byte", async () => {
    let releaseBind: (() => void) | undefined;
    const store = new MemoryAttemptStore();
    store.bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    let providerCalls = 0;
    const gatewayHeaders: Array<string | null> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        providerCalls += 1;
        gatewayHeaders.push(request.headers.get("x-gateway-auth"));
        return new Response(successfulBody, {
          headers: { "content-type": "application/json", "x-request-id": "req-1" },
        });
      },
    });
    servers.push(upstream);

    const first = startLargeReviewProviderProxy({
      ...proxyIdentity(`http://127.0.0.1:${upstream.port}/v1`),
      additionalAuthHeader: "x-gateway-auth",
      store,
    });
    enableLargeReview(first);
    const pending = fetch(`${first.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-auth": "fixture-auth",
      },
      body: requestBody,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(providerCalls).toBe(0);
    releaseBind?.();
    const original = await pending;
    expect(await original.text()).toBe(successfulBody);
    expect(original.headers.get("x-request-id")).toBe("req-1");
    expect(providerCalls).toBe(1);
    expect(gatewayHeaders).toEqual(["fixture-auth"]);
    expect(first.billingCanResumeExactly()).toBe(true);
    first.close();

    const resumed = startLargeReviewProviderProxy({
      ...proxyIdentity(`http://127.0.0.1:${upstream.port}/v1`),
      additionalAuthHeader: "x-gateway-auth",
      store,
    });
    enableLargeReview(resumed);
    const replay = await fetch(`${resumed.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-auth": "fixture-auth",
      },
      body: requestBody,
    });
    expect(await replay.text()).toBe(successfulBody);
    expect(replay.headers.get("x-request-id")).toBe("req-1");
    expect(providerCalls).toBe(1);
    expect(gatewayHeaders).toEqual(["fixture-auth"]);
    expect(resumed.billingCanResumeExactly()).toBe(true);
    await resumed.discardCompletedRun();
    expect(store.runs.size).toBe(0);
    expect(store.attempts.size).toBe(0);
    resumed.close();
  });

  test("does not persist retryable HTTP failures but resumes the later completed attempt", async () => {
    const store = new MemoryAttemptStore();
    let providerCalls = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        providerCalls += 1;
        if (providerCalls === 1) {
          return Response.json(
            { error: { message: "try later" } },
            { status: 429, headers: { "retry-after": "2" } },
          );
        }
        if (providerCalls === 2) {
          return Response.json(
            { error: { message: "provider unavailable" } },
            { status: 503 },
          );
        }
        return new Response(successfulBody, {
          headers: { "content-type": "application/json" },
        });
      },
    });
    servers.push(upstream);
    const seed = proxyIdentity(`http://127.0.0.1:${upstream.port}/v1`);
    const first = startLargeReviewProviderProxy({ ...seed, store });
    enableLargeReview(first);

    const throttled = await fetch(`${first.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("2");
    const unavailable = await fetch(`${first.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    expect(unavailable.status).toBe(503);
    const completed = await fetch(`${first.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    expect(completed.status).toBe(200);
    expect(providerCalls).toBe(3);
    first.close();

    const resumed = startLargeReviewProviderProxy({ ...seed, store });
    enableLargeReview(resumed);
    const replay = await fetch(`${resumed.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(successfulBody);
    expect(providerCalls).toBe(3);
    resumed.close();
  });

  test("does not cache an empty successful response", async () => {
    const store = new MemoryAttemptStore();
    let providerCalls = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        providerCalls += 1;
        return Response.json({ choices: [{ message: { content: "" } }] });
      },
    });
    servers.push(upstream);
    const proxy = startLargeReviewProviderProxy({
      ...proxyIdentity(`http://127.0.0.1:${upstream.port}/v1`),
      store,
    });
    enableLargeReview(proxy);
    const response = await fetch(`${proxy.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    expect(response.status).toBe(200);
    expect(store.attempts.size).toBe(0);
    expect(proxy.billingCanResumeExactly()).toBe(false);
    expect(providerCalls).toBe(1);
    proxy.close();
  });

  test("does not cache an ambiguous transport failure", async () => {
    const unavailable = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("unused");
      },
    });
    const port = unavailable.port;
    unavailable.stop(true);
    const store = new MemoryAttemptStore();
    const proxy = startLargeReviewProviderProxy({
      ...proxyIdentity(`http://127.0.0.1:${port}/v1`),
      store,
    });
    enableLargeReview(proxy);
    const response = await fetch(`${proxy.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    expect(response.status).toBe(502);
    expect(store.attempts.size).toBe(0);
    expect(proxy.billingCanResumeExactly()).toBe(false);
    proxy.close();
  });

  test("binds every required run and attempt identity component", () => {
    const base: LargeReviewRunIdentity = {
      repositoryId: 1,
      cliVersion: "0.8.0",
      configurationSha256: CONFIG_SHA,
      providerIdentity: '["managed","openai-compatible","https://example.test/v1"]',
      headSha: HEAD_SHA,
      planSha256: PLAN_SHA,
    };
    const runKey = largeReviewRunKey(base);
    for (const changed of [
      { ...base, repositoryId: 2 },
      { ...base, cliVersion: "0.8.1" },
      { ...base, configurationSha256: "d".repeat(64) },
      { ...base, providerIdentity: `${base.providerIdentity}/other` },
      { ...base, headSha: "e".repeat(40) },
      { ...base, planSha256: "f".repeat(64) },
    ]) {
      expect(largeReviewRunKey(changed)).not.toBe(runKey);
    }

    const attempt = {
      runKey,
      requestSha256: "1".repeat(64),
      batchIdentity: "2".repeat(64),
      attempt: 1,
      model: "model-a",
    };
    const attemptKey = largeReviewAttemptKey(attempt);
    expect(largeReviewAttemptKey({ ...attempt, requestSha256: "3".repeat(64) })).not.toBe(
      attemptKey,
    );
    expect(largeReviewAttemptKey({ ...attempt, batchIdentity: "4".repeat(64) })).not.toBe(
      attemptKey,
    );
    expect(largeReviewAttemptKey({ ...attempt, attempt: 2 })).not.toBe(attemptKey);
    expect(largeReviewAttemptKey({ ...attempt, model: "model-b" })).not.toBe(attemptKey);
  });

  test("hashes effective file labels and bytes deterministically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postil-large-review-config-"));
    try {
      await writeFile(join(dir, ".postil.yaml"), "enabled: true\n");
      const first = await hashEffectiveReviewConfiguration(dir, ["org:.postil.yaml"]);
      const second = await hashEffectiveReviewConfiguration(dir, ["org:.postil.yaml"]);
      const differentSource = await hashEffectiveReviewConfiguration(dir, [".postil.yaml"]);
      expect(first).toBe(second);
      expect(differentSource).not.toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
