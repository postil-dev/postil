import { describe, expect, test } from "bun:test";

import {
  githubResponseError,
  GithubRateLimitError,
} from "@/lib/github/rate-limit";

const NOW = Date.parse("2026-07-15T12:00:00.000Z");

describe("GitHub REST rate-limit classification", () => {
  test("uses Retry-After and primary reset headers", async () => {
    const retryAfter = await githubResponseError(
      "request",
      response(403, "forbidden", { "retry-after": "30" }),
      NOW,
    );
    expect(retryAfter).toBeInstanceOf(GithubRateLimitError);
    expect((retryAfter as GithubRateLimitError).retryAt.toISOString()).toBe(
      "2026-07-15T12:00:31.000Z",
    );

    const reset = await githubResponseError(
      "request",
      response(403, "forbidden", {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(NOW / 1000 + 90),
      }),
      NOW,
    );
    expect((reset as GithubRateLimitError).retryAt.toISOString()).toBe(
      "2026-07-15T12:01:31.000Z",
    );
  });

  test("recognizes headerless secondary limits but not ordinary authorization failures", async () => {
    const secondary = await githubResponseError(
      "request",
      response(403, JSON.stringify({ message: "You have exceeded a secondary rate limit." })),
      NOW,
    );
    expect(secondary).toBeInstanceOf(GithubRateLimitError);
    expect((secondary as GithubRateLimitError).retryAt.toISOString()).toBe(
      "2026-07-15T12:01:00.000Z",
    );

    const forbidden = await githubResponseError(
      "request",
      response(403, JSON.stringify({ message: "Resource not accessible by integration" })),
      NOW,
    );
    expect(forbidden).not.toBeInstanceOf(GithubRateLimitError);
    expect(forbidden.message).toBe(
      "GitHub request failed with HTTP 403 (the App installation cannot access this resource)",
    );
  });

  test("names the accepted permissions on a permission-denied 403", async () => {
    const denied = await githubResponseError(
      "active branch rules lookup",
      response(403, JSON.stringify({ message: "Resource not accessible by integration" }), {
        "x-accepted-github-permissions": "administration=read",
      }),
      NOW,
    );
    expect(denied).not.toBeInstanceOf(GithubRateLimitError);
    expect(denied.message).toBe(
      "GitHub active branch rules lookup failed with HTTP 403 " +
        "(GitHub App permissions accepted for this request: administration=read)",
    );

    const plain = await githubResponseError("request", response(500, "boom"), NOW);
    expect(plain.message).toBe("GitHub request failed with HTTP 500");
  });

  test("treats every 429 as rate limited", async () => {
    const error = await githubResponseError("request", response(429, ""), NOW);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect((error as GithubRateLimitError).retryAt.toISOString()).toBe(
      "2026-07-15T12:01:00.000Z",
    );
  });
});

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}
