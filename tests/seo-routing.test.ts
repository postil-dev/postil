import { describe, expect, test } from "bun:test";
import { NextRequest, type NextFetchEvent } from "next/server";

import robots from "@/app/robots";
import { SESSION_COOKIE, signSessionToken } from "@/lib/session-token";
import { middleware } from "@/middleware";

const event = {
  waitUntil: () => undefined,
} as unknown as NextFetchEvent;

function request(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(url, init);
}

function requestWithHost(url: string, host: string): NextRequest {
  return new NextRequest(url, { headers: { host } });
}

describe("crawler routing", () => {
  test("robots.txt keeps public crawl access open", () => {
    const policy = robots();

    expect(policy.rules).toEqual({
      userAgent: "*",
      allow: "/",
    });
    expect(policy.sitemap).toBe("https://postil.dev/sitemap.xml");
    expect(policy.host).toBe("https://postil.dev");
  });

  test("redirects the www host to the canonical apex host", async () => {
    const response = await middleware(
      request("https://www.postil.dev/docs?utm_source=test"),
      event,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/docs?utm_source=test",
    );
  });

  test("redirects the www Host header to the canonical apex host", async () => {
    const response = await middleware(
      requestWithHost("http://127.0.0.1/docs?utm_source=test", "www.postil.dev"),
      event,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/docs?utm_source=test",
    );
  });

  test("marks crawlable non-indexable surfaces with X-Robots-Tag", async () => {
    const login = await middleware(request("https://postil.dev/login"), event);
    const api = await middleware(request("https://postil.dev/api/health"), event);

    expect(login.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(api.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("keeps unauthenticated dashboard redirects out of the index", async () => {
    const response = await middleware(request("https://postil.dev/reports"), event);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/login?next=%2Freports",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("keeps authenticated dashboard responses out of the index", async () => {
    const secret = "session-secret-for-seo-routing-tests";
    const previousSecret = process.env.POSTIL_SESSION_SECRET;
    process.env.POSTIL_SESSION_SECRET = secret;

    try {
      const token = await signSessionToken("session-for-seo-routing", secret);
      const response = await middleware(
        request("https://postil.dev/reports", {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        }),
        event,
      );

      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    } finally {
      if (previousSecret === undefined) delete process.env.POSTIL_SESSION_SECRET;
      else process.env.POSTIL_SESSION_SECRET = previousSecret;
    }
  });
});
