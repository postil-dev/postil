import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Pool } from "pg";
import type { Database } from "@/lib/db";
import {
  buildManagedHostedChatCompletionRequest,
  resolveManagedHostedProviderProfile,
} from "@/lib/managed-hosted-provider-profile";

const profile = resolveManagedHostedProviderProfile({ POSTIL_PROVISIONAL_HOSTED_ROSTER: "1" });
const reconciled: Array<Record<string, unknown>> = [];
const released: string[] = [];
mock.module("@/lib/cli-auth", () => ({
  bearerCliToken: () => "fixture-cli-token",
  resolveCliToken: async () => ({ id: 1, orgId: 1 }),
  touchCliTokenLastUsed: async () => {},
}));
mock.module("@/lib/env", () => ({ hostedInferenceAvailable: async () => true }));
mock.module("@/lib/private-repository-entitlement", () => ({
  canProcessRepositoryInference: async () => ({ allowed: true }),
}));
mock.module("@/lib/hosted-usage-reservations", () => ({
  countCliGatewayReservationsLastHour: async () => 0,
  reserveHostedCliGatewaySpend: async () => ({ allowed: true, reservationId: "fixture-reservation" }),
  releaseHostedCliGatewaySpend: async (_db: unknown, id: string) => { released.push(id); },
  reconcileHostedCliGatewaySpend: async (_db: unknown, input: Record<string, unknown>) => {
    reconciled.push(input);
  },
}));
mock.module("@/lib/billing-credits", () => ({ calculateUsageCostMicrosForModel: () => 17 }));
mock.module("@/lib/managed-hosted-provider-profile", () => ({
  resolveManagedHostedProviderProfile: () => profile,
  buildManagedHostedChatCompletionRequest,
}));
mock.module("@/worker/review", () => ({
  resolveLlmConfig: async () => ({ ...profile, apiKey: "fixture-upstream-key" }),
}));
mock.module("@/worker/runner", () => ({ readPositiveIntEnv: () => 60 }));
const { runCliGatewayChatCompletion } = await import("@/lib/cli-gateway");
const originalFetch = globalThis.fetch;
const originalRoster = process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER;
const warning = spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRoster === undefined) delete process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER;
  else process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = originalRoster;
  reconciled.length = 0;
  released.length = 0;
  warning.mockClear();
});
afterAll(() => { warning.mockRestore(); mock.restore(); });

async function respond(body: unknown, status = 200) {
  process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = "1";
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    expect(request.provider.order).toEqual([profile.providerRoute]);
    expect(request.provider.allow_fallbacks).toBe(false);
    return Response.json(body, { status });
  }) as typeof fetch;
  return runCliGatewayChatCompletion({} as Database, {} as Pool, "Bearer fixture", "{}");
}

test("diagnoses HTTP 200 errors before identity rejection without changing accounting or the public error", async () => {
  const sensitive = "private-provider-payload-and-credential";
  const result = await respond({ error: { message: sensitive, type: sensitive, code: 503 } });
  expect(result).toEqual({ status: 502, body: { error: {
    message: "the upstream response identity did not match the hosted provider policy",
    type: "upstream_identity_mismatch",
  } } });
  expect(warning).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toEqual({
    event: "postil.cli_gateway.provider_failure", source: "upstream", upstream_status: 200,
    error_category: "upstream_error", error_type: "reported", error_code: 503,
    model_present: false, provider_present: false, usage_present: false,
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain(sensitive);
  expect(reconciled).toEqual([{
    reservationId: "fixture-reservation", promptTokens: 0, completionTokens: 0,
    modelUsed: profile.model, actualMicros: null, usageAccountingComplete: false,
  }]);
  expect(released).toEqual([]);
});

test("preserves successful content and reported usage without an error diagnostic", async () => {
  const body = { model: profile.model, provider: profile.providerName,
    error: false,
    choices: [{ message: { content: "review" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } };
  expect(await respond(body)).toEqual({ status: 200, body });
  expect(warning).not.toHaveBeenCalled();
  expect(reconciled[0]).toMatchObject({ actualMicros: 17, usageAccountingComplete: true });
  expect(released).toEqual([]);
});

test.each(["rate_limit_exceeded", "server"])("retains the documented %s error type without raw provider details", async (errorType) => {
  const sensitive = "private-provider-payload-and-credential";
  const result = await respond({ error: {
    message: sensitive, code: 503,
    metadata: { error_type: errorType, provider_code: sensitive, raw: sensitive },
  } });
  expect(result.status).toBe(502);
  expect(result.body).toMatchObject({ error: { type: "upstream_identity_mismatch" } });
  expect(warning).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
    upstream_status: 200, error_category: "upstream_error", error_type: errorType,
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain(sensitive);
  expect(reconciled[0]).toMatchObject({ actualMicros: null, usageAccountingComplete: false });
});

test("keeps non-error identity mismatches fail closed", async () => {
  const result = await respond({ model: "other/model", provider: "other-provider",
    choices: [{ message: { content: "review" } }] });
  expect(result.status).toBe(502);
  expect(result.body).toMatchObject({ error: { type: "upstream_identity_mismatch" } });
  expect(warning).not.toHaveBeenCalled();
  expect(reconciled[0]).toMatchObject({ actualMicros: null, usageAccountingComplete: false });
  expect(released).toEqual([]);
});

test("preserves non-2xx provider errors and reservation release", async () => {
  const body = { error: { type: "rate_limit_error", code: 429 } };
  expect(await respond(body, 429)).toEqual({ status: 429, body });
  expect(warning).toHaveBeenCalledTimes(1);
  expect(reconciled).toEqual([]);
  expect(released).toEqual(["fixture-reservation"]);
});

test("diagnoses partial generation errors while preserving valid identity, usage, and response", async () => {
  const sensitive = "private-partial-output-and-provider-credential";
  const body = {
    model: profile.model,
    provider: profile.providerName,
    usage: { prompt_tokens: 20, completion_tokens: 8 },
    choices: [
      { finish_reason: "stop", message: { content: "completed choice" } },
      {
        finish_reason: "error", message: { content: sensitive },
        error: { code: 502, message: sensitive, metadata: {
          error_type: "provider_unavailable", provider_code: sensitive, raw: sensitive,
        } },
      },
    ],
  };
  expect(await respond(body)).toEqual({ status: 200, body });
  expect(warning).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toEqual({
    event: "postil.cli_gateway.provider_failure", source: "upstream", upstream_status: 200,
    error_category: "upstream_error", error_type: "provider_unavailable", error_code: 502,
    model_present: true, provider_present: true, usage_present: true,
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain(sensitive);
  expect(reconciled).toEqual([{
    reservationId: "fixture-reservation", promptTokens: 20, completionTokens: 8,
    modelUsed: profile.model, actualMicros: 17, usageAccountingComplete: true,
  }]);
  expect(released).toEqual([]);
});

test("does not diagnose non-structured choice errors or errors without the error finish reason", async () => {
  for (const choice of [
    ...[false, "", null, [], "arbitrary provider content"].map((error) => ({
      finish_reason: "error", error,
    })),
    { finish_reason: "stop", error: { type: "provider_error" } },
  ]) {
    const body = { model: profile.model, provider: profile.providerName,
      usage: { prompt_tokens: 20, completion_tokens: 8 },
      choices: [{ ...choice, message: { content: "content" } }] };
    expect(await respond(body)).toEqual({ status: 200, body });
  }
  expect(warning).not.toHaveBeenCalled();
  expect(reconciled).toHaveLength(6);
  expect(reconciled.every((usage) => usage.usageAccountingComplete === true)).toBe(true);
  expect(released).toEqual([]);
});
