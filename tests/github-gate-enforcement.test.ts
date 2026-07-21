import { describe, expect, test } from "bun:test";

import {
  fetchGateEnforcementObservation,
  GithubRateLimitError,
} from "@/lib/github/gate-enforcement";

const APP_ID = 12345;

describe("GitHub gate enforcement evidence", () => {
  test("requires an exact case-sensitive context and integration identity", async () => {
    const requests: string[] = [];
    const observation = await fetchGateEnforcementObservation(
      "token",
      "acme/widget",
      APP_ID,
      {
        fetchImpl: sequenceFetch([
          json({ default_branch: "main" }),
          json({
            protected: true,
            protection: {
              required_status_checks: {
                contexts: ["postil/gate"],
              },
            },
          }),
          json([{
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "Postil/gate", integration_id: APP_ID },
                { context: "postil/gate", integration_id: APP_ID + 1 },
                { context: "postil/gate", integration_id: APP_ID },
              ],
            },
          }]),
        ], requests),
      },
    );

    expect(observation.status).toBe("required");
    expect(observation.defaultBranch).toBe("main");
    expect(observation.branchProtection).toBe("protected");
    expect(observation.evidence.branchProtection.exactMatch).toBe(false);
    expect(observation.evidence.activeRules.exactMatch).toBe(true);
    expect(requests[1]?.endsWith("/repos/acme/widget/branches/main")).toBe(true);
    expect(requests[1]?.endsWith("/protection")).toBe(false);
  });

  test("keeps classic branch protection unverified because its summary omits App identity", async () => {
    const observation = await fetchGateEnforcementObservation(
      "token",
      "acme/widget",
      APP_ID,
      {
        fetchImpl: sequenceFetch([
          json({ default_branch: "main" }),
          json({
            protected: true,
            protection: {
              required_status_checks: { contexts: ["postil/gate"] },
            },
          }),
          json([]),
        ]),
      },
    );

    expect(observation.status).toBe("unknown");
    expect(observation.evidence.branchProtection).toMatchObject({
      available: true,
      requiredStatusChecksPresent: true,
      exactMatch: false,
      match: "unknown_identity",
    });
  });

  test("counts checks-only classic summaries without trusting their App identity", async () => {
    const observation = await fetchGateEnforcementObservation(
      "token",
      "acme/widget",
      APP_ID,
      {
        fetchImpl: sequenceFetch([
          json({ default_branch: "main" }),
          json({
            protected: true,
            protection: {
              required_status_checks: {
                contexts: [],
                checks: [{ context: "postil/gate", app_id: APP_ID }],
              },
            },
          }),
          json([]),
        ]),
      },
    );

    expect(observation.status).toBe("unknown");
    expect(observation.evidence.branchProtection).toMatchObject({
      requiredStatusChecksPresent: true,
      exactMatch: false,
      match: "unknown_identity",
    });
  });

  test("paginates active branch rules and accepts their exact integration", async () => {
    const firstPage = Array.from({ length: 100 }, () => ({ type: "creation" }));
    const observation = await fetchGateEnforcementObservation(
      "token",
      "acme/widget",
      APP_ID,
      {
        fetchImpl: sequenceFetch([
          json({ default_branch: "trunk" }),
          json({ protected: false, protection: { enabled: false } }),
          json(firstPage, {
            link: '<https://api.github.com/resource?page=2>; rel="next"',
          }),
          json([
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [
                  { context: "postil/gate", integration_id: APP_ID },
                ],
              },
            },
          ]),
        ]),
      },
    );

    expect(observation.status).toBe("required");
    expect(observation.branchProtection).toBe("unprotected");
    expect(observation.evidence.activeRules).toEqual({
      available: true,
      pagesRead: 2,
      exactMatch: true,
      match: "exact_app",
    });
  });

  test("requires the exact App identity for active rulesets", async () => {
    for (const testCase of [
      { integrationId: undefined, match: "unknown_identity", status: "unknown" },
      { integrationId: null, match: "any_source", status: "not_required" },
      { integrationId: -1, match: "any_source", status: "not_required" },
      { integrationId: APP_ID + 1, match: "foreign_app", status: "not_required" },
      { integrationId: APP_ID, match: "exact_app", status: "required" },
    ] as const) {
      const check = {
        context: "postil/gate",
        ...(testCase.integrationId === undefined ? {} : { integration_id: testCase.integrationId }),
      };
      const observation = await fetchGateEnforcementObservation("token", "acme/widget", APP_ID, {
        fetchImpl: sequenceFetch([
          json({ default_branch: "main" }),
          json({ protected: false, protection: { enabled: false } }),
          json([{ type: "required_status_checks", parameters: { required_status_checks: [check] } }]),
        ]),
      });
      expect(observation.status).toBe(testCase.status);
      expect(observation.evidence.activeRules.match).toBe(testCase.match);
    }
  });

  test("keeps unreadable or malformed branch evidence unknown", async () => {
    const observation = await fetchGateEnforcementObservation(
      "token",
      "acme/widget",
      APP_ID,
      {
        fetchImpl: sequenceFetch([
          json({ default_branch: "main" }),
          new Response("", { status: 403 }),
          json([]),
        ]),
      },
    );

    expect(observation.status).toBe("unknown");
    expect(observation.error).toContain("default branch lookup failed with HTTP 403");

    const malformed = await fetchGateEnforcementObservation(
      "token",
      "acme/widget",
      APP_ID,
      {
        fetchImpl: sequenceFetch([
          json({ default_branch: "main" }),
          json({ protected: true, protection: {} }),
          json([]),
        ]),
      },
    );
    expect(malformed.status).toBe("unknown");
    expect(malformed.error).toContain("omitted its status-check summary");
  });

  test("keeps malformed active required-check rules unknown", async () => {
    const observation = await fetchGateEnforcementObservation(
      "token",
      "acme/widget",
      APP_ID,
      {
        fetchImpl: sequenceFetch([
          json({ default_branch: "main" }),
          json({ protected: false, protection: { enabled: false } }),
          json([{
            type: "required_status_checks",
            parameters: { required_status_checks: "postil/gate" },
          }]),
        ]),
      },
    );

    expect(observation.status).toBe("unknown");
    expect(observation.error).toContain("invalid required status checks");
  });

  test("surfaces GitHub's rate reset for durable rescheduling", async () => {
    const retry = fetchGateEnforcementObservation("token", "acme/widget", APP_ID, {
      fetchImpl: sequenceFetch([
        json({ default_branch: "main" }),
        new Response("", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1784116800",
          },
        }),
      ]),
    });
    await expect(retry).rejects.toBeInstanceOf(GithubRateLimitError);
    await retry.catch((error: GithubRateLimitError) => {
      expect(error.retryAt.toISOString()).toBe("2026-07-15T12:00:01.000Z");
    });
  });
});

function json(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sequenceFetch(responses: Response[], requests?: string[]): typeof fetch {
  let index = 0;
  return (async (input: RequestInfo | URL) => {
    requests?.push(String(input));
    const response = responses[index++];
    if (!response) throw new Error("unexpected fetch");
    return response;
  }) as unknown as typeof fetch;
}
