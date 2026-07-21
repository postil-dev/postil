import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_OPENROUTER_REVIEW_OUTAGE_THRESHOLD_USD,
  configuredOpenRouterReviewOutageThresholdUsd,
  runOpenRouterCapMonitoringChecks,
} from "@/lib/openrouter-cap-monitoring";

const KEY_NAMES = {
  development: "development-fixture",
  production: "production-fixture",
  emergency: "emergency-fixture",
} as const;

describe("OpenRouter key-cap monitoring", () => {
  test("keeps account balance, daily key caps, and emergency-key invariants distinct", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const checks = await runOpenRouterCapMonitoringChecks({
      managementKey: "fixture-management-credential",
      keyNames: KEY_NAMES,
      fetchImpl: metadataFetch(
        [
          keyMetadata(KEY_NAMES.development, { limit_remaining: 0.75 }),
          keyMetadata(KEY_NAMES.production, { limit_remaining: 18 }),
          keyMetadata(KEY_NAMES.emergency, { limit: 5, limit_remaining: 5 }),
        ],
        { total_credits: 100, total_usage: 20 },
        calls,
      ),
    });

    expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual([
      "/api/v1/credits",
      "/api/v1/keys",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer fixture-management-credential")).toBe(true);
    expect(check(checks, "openrouter-development-daily-cap")).toMatchObject({
      healthy: false,
      severity: "critical",
    });
    expect(check(checks, "openrouter-production-daily-cap").healthy).toBe(true);
    expect(check(checks, "openrouter-account-balance").healthy).toBe(true);
    expect(check(checks, "openrouter-emergency-configuration").healthy).toBe(true);
    expect(check(checks, "openrouter-emergency-unused").healthy).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("fixture-management-credential");
    expect(JSON.stringify(checks)).not.toContain("fixture-sensitive-hash");
    expect(JSON.stringify(checks)).not.toContain("fixture-sensitive-label");
    expect(check(checks, "openrouter-development-daily-cap").detail).toContain(
      "Account balance is evaluated separately.",
    );
    expect(check(checks, "openrouter-account-balance").detail).toContain(
      "not a per-key daily allowance",
    );
  });

  test("alerts on account depletion without misreporting healthy daily caps", async () => {
    const checks = await runOpenRouterCapMonitoringChecks({
      managementKey: "fixture-management-credential",
      keyNames: KEY_NAMES,
      fetchImpl: metadataFetch(
        [
          keyMetadata(KEY_NAMES.development),
          keyMetadata(KEY_NAMES.production),
          keyMetadata(KEY_NAMES.emergency),
        ],
        { total_credits: 30, total_usage: 29.5 },
      ),
    });

    expect(check(checks, "openrouter-account-balance").healthy).toBe(false);
    expect(check(checks, "openrouter-development-daily-cap").healthy).toBe(true);
    expect(check(checks, "openrouter-production-daily-cap").healthy).toBe(true);
  });

  test("fails closed when review keys are disabled, uncapped, or not daily", async () => {
    const checks = await runOpenRouterCapMonitoringChecks({
      managementKey: "fixture-management-credential",
      keyNames: KEY_NAMES,
      fetchImpl: metadataFetch(
        [
          keyMetadata(KEY_NAMES.development, { disabled: true }),
          keyMetadata(KEY_NAMES.production, { limit_reset: "monthly" }),
          keyMetadata(KEY_NAMES.emergency, { limit: null, limit_remaining: null }),
        ],
        { total_credits: 100, total_usage: 10 },
      ),
    });

    expect(check(checks, "openrouter-development-daily-cap").healthy).toBe(false);
    expect(check(checks, "openrouter-production-daily-cap").healthy).toBe(false);
    expect(check(checks, "openrouter-emergency-configuration").healthy).toBe(false);
  });

  test("detects any emergency-key inference usage", async () => {
    const checks = await runOpenRouterCapMonitoringChecks({
      managementKey: "fixture-management-credential",
      keyNames: KEY_NAMES,
      fetchImpl: metadataFetch(
        [
          keyMetadata(KEY_NAMES.development),
          keyMetadata(KEY_NAMES.production),
          keyMetadata(KEY_NAMES.emergency, {
            usage: 0.25,
            usage_daily: 0.25,
            usage_weekly: 0.25,
            usage_monthly: 0.25,
          }),
        ],
        { total_credits: 100, total_usage: 10 },
      ),
    });

    const emergency = check(checks, "openrouter-emergency-unused");
    expect(emergency.healthy).toBe(false);
    expect(emergency.detail).toContain("Emergency key usage is nonzero");
  });

  test("turns a rejected management credential into private critical incidents", async () => {
    const checks = await runOpenRouterCapMonitoringChecks({
      managementKey: "rejected-fixture-credential",
      keyNames: KEY_NAMES,
      fetchImpl: async () =>
        new Response("provider-body-credential-fixture", { status: 401 }),
    });

    expect(checks).toHaveLength(2);
    expect(check(checks, "openrouter-keys-metadata")).toMatchObject({
      healthy: false,
      severity: "critical",
      detail: "OpenRouter management credential was rejected with HTTP 401.",
    });
    expect(check(checks, "openrouter-credits-metadata").healthy).toBe(false);
    expect(JSON.stringify(checks)).not.toContain("rejected-fixture-credential");
    expect(JSON.stringify(checks)).not.toContain(
      "provider-body-credential-fixture",
    );
  });

  test("finds exact keys on later bounded metadata pages", async () => {
    let keyPage = 0;
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/credits") {
        return Response.json({ data: { total_credits: 100, total_usage: 10 } });
      }
      keyPage += 1;
      if (url.searchParams.get("offset") === "0") {
        return Response.json({
          data: Array.from({ length: 100 }, (_, index) => ({ name: `noise-${index}` })),
        });
      }
      return Response.json({
        data: [
          keyMetadata(KEY_NAMES.development),
          keyMetadata(KEY_NAMES.production),
          keyMetadata(KEY_NAMES.emergency),
        ],
      });
    };

    const checks = await runOpenRouterCapMonitoringChecks({
      managementKey: "fixture-management-credential",
      keyNames: KEY_NAMES,
      fetchImpl,
    });

    expect(keyPage).toBe(2);
    expect(checks).toHaveLength(7);
    expect(checks.every((candidate) => candidate.healthy)).toBe(true);
  });

  test("uses the maximum hosted reservation as the default outage threshold", () => {
    expect(DEFAULT_OPENROUTER_REVIEW_OUTAGE_THRESHOLD_USD).toBe(1);
    expect(configuredOpenRouterReviewOutageThresholdUsd()).toBe(1);
    expect(configuredOpenRouterReviewOutageThresholdUsd("2.5")).toBe(2.5);
    expect(() => configuredOpenRouterReviewOutageThresholdUsd("0")).toThrow(
      /greater than 0/,
    );
    expect(() => configuredOpenRouterReviewOutageThresholdUsd("unknown")).toThrow(
      /greater than 0/,
    );
  });

  test("keeps management and emergency identities out of local inference paths", async () => {
    const root = join(import.meta.dir, "..");
    const sources = await Promise.all(
      [
        "scripts/run-review-locally.ts",
        "scripts/install-local-postil-hook.ts",
        "src/worker/review.ts",
      ].map((path) => readFile(join(root, path), "utf8")),
    );
    const localInferenceSources = sources.join("\n");

    expect(localInferenceSources).not.toContain("POSTIL_OPENROUTER_EMERGENCY_KEY_NAME");
    expect(sources[0]).not.toContain("OPENROUTER_MANAGEMENT_API_KEY");
    expect(localInferenceSources).toContain('OPENROUTER_MANAGEMENT_API_KEY: ""');
    expect(sources[0]).toContain('"OPENROUTER_API_KEY"');
  });
});

function check(
  checks: Awaited<ReturnType<typeof runOpenRouterCapMonitoringChecks>>,
  key: string,
) {
  const match = checks.find((candidate) => candidate.key === key);
  if (!match) throw new Error(`missing check ${key}`);
  return match;
}

function metadataFetch(
  keys: unknown[],
  credits: { total_credits: number; total_usage: number },
  calls: Array<{ url: string; authorization: string | null }> = [],
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.toString(),
      authorization: headers.get("authorization"),
    });
    return url.pathname === "/api/v1/keys"
      ? Response.json({ data: keys })
      : Response.json({ data: credits });
  };
}

function keyMetadata(
  name: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    name,
    hash: "fixture-sensitive-hash",
    label: "fixture-sensitive-label",
    disabled: false,
    limit: 30,
    limit_remaining: 20,
    limit_reset: "daily",
    usage: 10,
    usage_daily: 10,
    usage_weekly: 10,
    usage_monthly: 10,
    byok_usage: 0,
    byok_usage_daily: 0,
    byok_usage_weekly: 0,
    byok_usage_monthly: 0,
    ...(
      name === KEY_NAMES.emergency
        ? {
            usage: 0,
            usage_daily: 0,
            usage_weekly: 0,
            usage_monthly: 0,
          }
        : {}
    ),
    ...overrides,
  };
}
