import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest, type NextFetchEvent } from "next/server";

import * as dbModule from "@/lib/db";
import { REQUESTED_PATH_HEADER } from "@/lib/oauth";
import { SESSION_COOKIE, signSessionToken } from "@/lib/session-token";

const RUN_PATH = "/orgs/runatlas-is/runs/4e08269c-d327-46c7-9e56-26c4f014ad34";
const SESSION_SECRET = "test-session-secret";

/**
 * The middleware admits any request whose session cookie signature verifies,
 * so an expired or revoked session is only caught by the page beneath it.
 * These cover the return path for that redirect, which is the one a deep link
 * from a GitHub check run depends on.
 */

let requestHeaders = new Headers();

mock.module("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => new Map(),
}));

const redirectCalls: string[] = [];

class RedirectSignal extends Error {}

mock.module("next/navigation", () => ({
  redirect: (destination: string) => {
    redirectCalls.push(destination);
    throw new RedirectSignal(destination);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

mock.module("@/lib/db", () => ({ ...dbModule, getDb: () => fakeDb() }));
mock.module("@/lib/github/installation-sync", () => ({
  syncInstallationsFromGithub: async () => undefined,
  findAccessibleInstallationOrgSlug: async () => "setup-org",
}));
mock.module("@/lib/org-sync", () => ({ reconcileOrgMemberships: async () => undefined }));

const { loginRedirectPath } = await import("@/lib/session");
const { middleware } = await import("@/middleware");
const { default: LoginPage } = await import("@/app/login/page");
const { GET: oauthStart } = await import("@/app/api/auth/login/route");
const { GET: oauthCallback } = await import("@/app/api/auth/callback/route");
const { requireOrgMembership } = await import("@/lib/org-access");

const event = { waitUntil: () => undefined } as unknown as NextFetchEvent;

function fakeDb() {
  // `values()` is awaited directly when creating a session and chained when
  // upserting the user, so it has to be both thenable and chainable.
  const values = () => ({
    then: (resolve: (value: unknown) => unknown) => resolve(undefined),
    onConflictDoUpdate: () => ({ returning: async () => [{ id: 42 }] }),
  });
  return { insert: () => ({ values }) } as never;
}

function withRequestedPath(path: string | null): void {
  requestHeaders = new Headers(path ? { [REQUESTED_PATH_HEADER]: path } : {});
}

/** Read the request headers the middleware forwards to the page beneath it. */
function forwardedRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

/** Merge Set-Cookie headers the way a browser would. */
function absorb(jar: Map<string, string>, response: Response): void {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    if (raw.includes("Expires=Thu, 01 Jan 1970")) jar.delete(name);
    else jar.set(name, pair.slice(separator + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

beforeEach(() => {
  process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
  process.env.POSTIL_SESSION_SECRET = SESSION_SECRET;
  process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-client-secret";
  process.env.POSTIL_SEALING_KEY =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  withRequestedPath(null);
  redirectCalls.length = 0;
});

describe("sign-in return path", () => {
  test("middleware forwards the requested path to a page it admits on signature", async () => {
    const token = await signSessionToken("a".repeat(43), SESSION_SECRET);
    const response = await middleware(
      new NextRequest(`https://postil.dev${RUN_PATH}?tab=findings`, {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
      event,
    );

    expect(response.headers.get("location")).toBeNull();
    expect(forwardedRequestHeader(response, REQUESTED_PATH_HEADER)).toBe(
      `${RUN_PATH}?tab=findings`,
    );
  });

  test("middleware overwrites a client-supplied requested path", async () => {
    const token = await signSessionToken("a".repeat(43), SESSION_SECRET);
    const response = await middleware(
      new NextRequest(`https://postil.dev${RUN_PATH}`, {
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          [REQUESTED_PATH_HEADER]: "https://evil.example/steal",
        },
      }),
      event,
    );

    expect(forwardedRequestHeader(response, REQUESTED_PATH_HEADER)).toBe(RUN_PATH);
  });

  // This is the gate that a deep link actually hits: the middleware admitted
  // the request on a valid signature, and only here does the expired session
  // row surface.
  test("the organization gate sends an expired session back to the requested run", async () => {
    withRequestedPath(RUN_PATH);

    await expect(requireOrgMembership("runatlas-is")).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(redirectCalls).toEqual([`/login?next=${encodeURIComponent(RUN_PATH)}`]);
  });

  test("preserves a relative protected path", async () => {
    withRequestedPath(`${RUN_PATH}?tab=findings`);

    expect(await loginRedirectPath()).toBe(
      `/login?next=${encodeURIComponent(`${RUN_PATH}?tab=findings`)}`,
    );
  });

  test("keeps the destination alongside a verification error", async () => {
    withRequestedPath(RUN_PATH);

    expect(await loginRedirectPath("membership_verification")).toBe(
      `/login?error=membership_verification&next=${encodeURIComponent(RUN_PATH)}`,
    );
  });

  test("rejects an absolute URL destination", async () => {
    withRequestedPath("https://evil.example/orgs/acme");

    expect(await loginRedirectPath()).toBe("/login");
  });

  test("rejects a protocol-relative destination", async () => {
    withRequestedPath("//evil.com/orgs/acme");

    expect(await loginRedirectPath()).toBe("/login");
  });

  test("ignores a path outside the protected surface", async () => {
    withRequestedPath("/api/auth/logout");

    expect(await loginRedirectPath()).toBe("/login");
  });

  test("carries a run deep link through the whole sign-in round trip", async () => {
    const jar = new Map<string, string>();

    // The page gate rejects a signature-valid but expired session.
    withRequestedPath(RUN_PATH);
    const gateRedirect = await loginRedirectPath();
    expect(gateRedirect).toBe(`/login?next=${encodeURIComponent(RUN_PATH)}`);

    // The login page turns it into an OAuth start link.
    const nextParam = new URL(gateRedirect, "https://postil.dev").searchParams.get("next");
    const markup = renderToStaticMarkup(
      await LoginPage({ searchParams: Promise.resolve({ next: nextParam ?? undefined }) }),
    );
    const href = /href="(\/api\/auth\/login[^"]*)"/.exec(markup)?.[1];
    expect(href).toBe(`/api/auth/login?next=${encodeURIComponent(RUN_PATH)}`);

    // OAuth start binds it to the attempt.
    const start = await oauthStart(new Request(`https://postil.dev${href}`));
    absorb(jar, start);
    expect(start.headers.get("location")).toStartWith(
      "https://github.com/login/oauth/authorize?",
    );

    // GitHub returns to the callback, which lands the user on the run page.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("access_token")) return Response.json({ access_token: "token" });
      if (url.endsWith("/user")) {
        return Response.json({
          id: 1,
          login: "octocat",
          name: null,
          email: null,
          avatar_url: null,
        });
      }
      return Response.json([]);
    }) as typeof fetch;

    const callback = await oauthCallback(
      new Request(
        `https://postil.dev/api/auth/callback?code=c&state=${jar.get("postil_oauth_state")}`,
        { headers: { cookie: cookieHeader(jar) } },
      ),
    );

    expect(callback.headers.get("location")).toBe(`https://postil.dev${RUN_PATH}`);
  });

  test("falls back to the default landing page when the destination is unsafe", async () => {
    const jar = new Map<string, string>();

    withRequestedPath("//evil.com/orgs/acme");
    const gateRedirect = await loginRedirectPath();
    expect(gateRedirect).toBe("/login");

    const start = await oauthStart(new Request("https://postil.dev/api/auth/login"));
    absorb(jar, start);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("access_token")) return Response.json({ access_token: "token" });
      if (url.endsWith("/user")) {
        return Response.json({
          id: 1,
          login: "octocat",
          name: null,
          email: null,
          avatar_url: null,
        });
      }
      return Response.json([]);
    }) as typeof fetch;

    const callback = await oauthCallback(
      new Request(
        `https://postil.dev/api/auth/callback?code=c&state=${jar.get("postil_oauth_state")}`,
        { headers: { cookie: cookieHeader(jar) } },
      ),
    );

    expect(callback.headers.get("location")).toBe("https://postil.dev/orgs/setup-org");
  });
});
