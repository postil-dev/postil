import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  fetchAllActiveOrgMemberships,
  nextPageUrl,
} from "@/lib/github/user-memberships";

const ORIGINAL_FETCH = globalThis.fetch;
let responses: Array<Response | Error> = [];
let requests: Array<{ url: string; authorization: string | null }> = [];

beforeEach(() => {
  responses = [];
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      authorization: headers.get("authorization"),
    });
    const response = responses.shift();
    if (!response) throw new Error("unexpected GitHub request");
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("GitHub user organization memberships", () => {
  test("returns every page and authenticates each request", async () => {
    responses = [
      jsonResponse(
        [{ role: "admin", organization: { id: 10, login: "alpha" } }],
        '<https://api.github.com/user/memberships/orgs?page=2>; rel="next"',
      ),
      jsonResponse([{ role: "member", organization: { id: 11, login: "beta" } }]),
    ];

    const result = await fetchAllActiveOrgMemberships("test-token");

    expect(result).toEqual({
      ok: true,
      memberships: [
        { role: "admin", organization: { id: 10, login: "alpha" } },
        { role: "member", organization: { id: 11, login: "beta" } },
      ],
    });
    expect(requests).toEqual([
      {
        url: "https://api.github.com/user/memberships/orgs?per_page=100&state=active",
        authorization: "Bearer test-token",
      },
      {
        url: "https://api.github.com/user/memberships/orgs?page=2",
        authorization: "Bearer test-token",
      },
    ]);
  });

  test("distinguishes a revoked token from a retryable GitHub failure", async () => {
    responses = [new Response("bad credentials", { status: 401 })];
    expect(await fetchAllActiveOrgMemberships("revoked-token")).toEqual({
      ok: false,
      reason: "unauthorized",
    });

    responses = [new Response("rate limited", { status: 429 })];
    expect(await fetchAllActiveOrgMemberships("valid-token")).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: 60_000,
    });
  });

  test("rejects incomplete, malformed, and off-origin pagination", async () => {
    responses = [new Response("{", { status: 200 })];
    expect(await fetchAllActiveOrgMemberships("token")).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: 30_000,
    });

    responses = [
      jsonResponse(
        [],
        '<https://attacker.example/user/memberships/orgs?page=2>; rel="next"',
      ),
    ];
    expect(await fetchAllActiveOrgMemberships("token")).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: 30_000,
    });
  });

  test("treats network errors as retryable without returning partial data", async () => {
    responses = [
      jsonResponse(
        [{ role: "admin", organization: { id: 10, login: "alpha" } }],
        '<https://api.github.com/user/memberships/orgs?page=2>; rel="next"',
      ),
      new Error("network unavailable"),
    ];

    expect(await fetchAllActiveOrgMemberships("token")).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: 30_000,
    });
  });

  test("honors GitHub retry headers within bounded limits", async () => {
    responses = [
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    ];
    expect(await fetchAllActiveOrgMemberships("token")).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: 120_000,
    });

    responses = [
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "86400" },
      }),
    ];
    expect(await fetchAllActiveOrgMemberships("token")).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: 3_600_000,
    });

    const resetAt = Math.ceil(Date.now() / 1_000) + 90;
    responses = [
      new Response("rate limited", {
        status: 429,
        headers: {
          "retry-after": "invalid",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        },
      }),
    ];
    const resetResult = await fetchAllActiveOrgMemberships("token");
    expect(resetResult).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    if (resetResult.ok || resetResult.reason !== "unavailable") {
      throw new Error("expected a retryable membership response");
    }
    expect(resetResult.retryAfterMs).toBeGreaterThanOrEqual(89_000);
    expect(resetResult.retryAfterMs).toBeLessThanOrEqual(91_000);
  });

  test("keeps the rate-limit fallback when the reset header is absent or invalid", async () => {
    for (const resetHeader of [undefined, "invalid"]) {
      responses = [
        new Response("rate limited", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            ...(resetHeader
              ? { "x-ratelimit-reset": resetHeader }
              : {}),
          },
        }),
      ];

      expect(await fetchAllActiveOrgMemberships("token")).toEqual({
        ok: false,
        reason: "unavailable",
        retryAfterMs: 60_000,
      });
    }
  });
});

describe("GitHub pagination links", () => {
  test("accepts only GitHub API next links", () => {
    expect(
      nextPageUrl('<https://api.github.com/user/memberships/orgs?page=2>; rel="next"'),
    ).toBe("https://api.github.com/user/memberships/orgs?page=2");
    expect(nextPageUrl('<https://example.com/page=2>; rel="next"')).toBeUndefined();
    expect(nextPageUrl('<https://api.github.com/page=1>; rel="prev"')).toBeNull();
  });
});

function jsonResponse(value: unknown, link?: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(link ? { link } : {}),
    },
  });
}
