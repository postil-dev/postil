import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, type NextFetchEvent } from "next/server";

import robots from "@/app/robots";
import { PROTECTED_RETURN_TO_HEADER } from "@/lib/auth-navigation";
import { SESSION_COOKIE, signSessionToken } from "@/lib/session-token";
import { middleware } from "@/middleware";

const event = {
  waitUntil: () => undefined,
} as unknown as NextFetchEvent;

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(url: string, init?: NextRequestInit): NextRequest {
  return new NextRequest(url, init);
}

function requestWithHost(url: string, host: string): NextRequest {
  return new NextRequest(url, { headers: { host } });
}

describe("crawler routing", () => {
  test("describes repository corroboration accurately", async () => {
    const landingSource = await readFile(
      join(import.meta.dir, "..", "src", "app", "page.tsx"),
      "utf8",
    );
    const changelogSource = await readFile(
      join(import.meta.dir, "..", "src", "app", "changelog", "page.tsx"),
      "utf8",
    );

    expect(landingSource).toContain("searches the checked-out");
    expect(landingSource).toContain(
      "repository when a claim depends on surrounding code",
    );
    expect(landingSource).not.toContain("not your repository");
    expect(landingSource).not.toContain("outside the diff");
    expect(changelogSource).toContain("withholds repository-dependent claims");
    expect(changelogSource).not.toContain("exact diff evidence");
  });

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

  test("keeps unauthenticated GET redirects replay-safe and out of the index", async () => {
    const response = await middleware(
      request("https://postil.dev/reports?status=failed", { method: "GET" }),
      event,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/login?next=%2Freports%3Fstatus%3Dfailed",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("converts unauthenticated protected POST requests to login GET navigation", async () => {
    const response = await middleware(
      request("https://postil.dev/cli/authorize?code=device-code", {
        method: "POST",
        body: "decision=approve",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      event,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/login?next=%2Fcli%2Fauthorize%3Fcode%3Ddevice-code",
    );
  });

  test("preserves a protected query in the post-login return target", async () => {
    const response = await middleware(
      request("https://postil.dev/reports?status=failed&gate=failing"),
      event,
    );

    expect(response.headers.get("location")).toBe(
      "https://postil.dev/login?next=%2Freports%3Fstatus%3Dfailed%26gate%3Dfailing",
    );
  });

  test("login redirect targets the public origin, not the proxy-internal one", async () => {
    const previousPublicUrl = process.env.POSTIL_PUBLIC_URL;
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    try {
      const response = await middleware(request("http://localhost:3000/reports"), event);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "https://postil.dev/login?next=%2Freports",
      );
    } finally {
      if (previousPublicUrl === undefined) delete process.env.POSTIL_PUBLIC_URL;
      else process.env.POSTIL_PUBLIC_URL = previousPublicUrl;
    }
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

  test("stamps the exact protected target for page-level session checks", async () => {
    const secret = "session-secret-for-protected-target-tests";
    const previousSecret = process.env.POSTIL_SESSION_SECRET;
    process.env.POSTIL_SESSION_SECRET = secret;
    const target =
      "/orgs/example-org/runs/11111111-2222-4333-8444-555555555555?tab=findings&severity=error";

    try {
      const token = await signSessionToken("session-for-protected-target", secret);
      const response = await middleware(
        request(`https://postil.dev${target}`, {
          headers: {
            cookie: `${SESSION_COOKIE}=${token}`,
            [PROTECTED_RETURN_TO_HEADER]: "https://evil.example/account",
          },
        }),
        event,
      );

      expect(
        response.headers.get(
          `x-middleware-request-${PROTECTED_RETURN_TO_HEADER}`,
        ),
      ).toBe(target);
    } finally {
      if (previousSecret === undefined) delete process.env.POSTIL_SESSION_SECRET;
      else process.env.POSTIL_SESSION_SECRET = previousSecret;
    }
  });
});
