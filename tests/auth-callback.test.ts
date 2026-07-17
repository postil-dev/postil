import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as dbModule from "@/lib/db";

interface AccountRef {
  githubId: number;
  login: string;
  type: "User" | "Organization";
}

interface AccountMembership {
  githubOrgId: number;
  role: string;
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;
const ORIGINAL_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
const ORIGINAL_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;

const syncCalls: AccountRef[][] = [];
const reconciliationCalls: Array<{ userId: number; accounts: AccountMembership[] }> = [];
const sessionCalls: Array<{
  userId: number;
  accessToken: string;
  membershipCheckedAt: Date;
}> = [];
const requestedUrls: string[] = [];
let githubResponses: Array<Response | Error> = [];

mock.module("@/lib/db", () => ({
  ...dbModule,
  getDb: () => fakeDb(),
}));

mock.module("@/lib/github/installation-sync", () => ({
  syncInstallationsFromGithub: async (accounts: AccountRef[]) => {
    syncCalls.push(accounts);
  },
}));

mock.module("@/lib/org-sync", () => ({
  reconcileOrgMemberships: async (
    _db: unknown,
    userId: number,
    accounts: AccountMembership[],
  ) => {
    reconciliationCalls.push({ userId, accounts });
  },
}));

mock.module("@/lib/session", () => ({
  createSession: async (
    userId: number,
    accessToken: string,
    membershipCheckedAt: Date,
  ) => {
    sessionCalls.push({ userId, accessToken, membershipCheckedAt });
    return "signed-session";
  },
  SESSION_COOKIE: "postil_session",
  SESSION_TTL_SECONDS: 7 * 24 * 60 * 60,
}));

const { GET } = await import("@/app/api/auth/callback/route");

beforeEach(() => {
  process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
  process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-client-secret";
  syncCalls.length = 0;
  reconciliationCalls.length = 0;
  sessionCalls.length = 0;
  requestedUrls.length = 0;
  githubResponses = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrls.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const response = githubResponses.shift();
    if (!response) throw new Error("unexpected GitHub request");
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreEnv("POSTIL_PUBLIC_URL", ORIGINAL_PUBLIC_URL);
  restoreEnv("GITHUB_OAUTH_CLIENT_ID", ORIGINAL_CLIENT_ID);
  restoreEnv("GITHUB_OAUTH_CLIENT_SECRET", ORIGINAL_CLIENT_SECRET);
});

describe("GET /api/auth/callback", () => {
  test("does not create a session when GitHub organization membership reconciliation fails", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      new Response("unavailable", { status: 503 }),
    ];

    const response = await GET(callbackRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/login?error=organization_memberships",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "postil_oauth_state=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
    expect(syncCalls).toEqual([]);
    expect(reconciliationCalls).toEqual([]);
    expect(sessionCalls).toEqual([]);
  });

  test("shows the retryable error when the membership request throws", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      new Error("network unavailable"),
    ];

    assertMembershipFailure(await GET(callbackRequest()));
  });

  test("shows the retryable error when GitHub returns malformed membership JSON", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    ];

    assertMembershipFailure(await GET(callbackRequest()));
  });

  test("rejects membership pagination that remains incomplete at the page cap", async () => {
    const link = '<https://api.github.com/user/memberships/orgs?page=2>; rel="next"';
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      ...Array.from({ length: 100 }, () => jsonResponse([], { link })),
    ];

    assertMembershipFailure(await GET(callbackRequest()));
    expect(requestedUrls).toHaveLength(102);
  });

  test("reconciles the personal account and every organization before creating a session", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      jsonResponse([
        {
          role: "admin",
          state: "active",
          organization: { id: 2001, login: "alpha-org" },
        },
        {
          role: "member",
          state: "active",
          organization: { id: 2002, login: "beta-org" },
        },
      ]),
    ];

    const response = await GET(callbackRequest());

    expect(syncCalls).toEqual([
      [
        { githubId: 1001, login: "octocat", type: "User" },
        { githubId: 2001, login: "alpha-org", type: "Organization" },
        { githubId: 2002, login: "beta-org", type: "Organization" },
      ],
    ]);
    expect(reconciliationCalls).toEqual([
      {
        userId: 77,
        accounts: [
          { githubOrgId: 1001, role: "admin" },
          { githubOrgId: 2001, role: "admin" },
          { githubOrgId: 2002, role: "member" },
        ],
      },
    ]);
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]).toMatchObject({
      userId: 77,
      accessToken: "user-access-token",
    });
    expect(sessionCalls[0]?.membershipCheckedAt).toBeInstanceOf(Date);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://postil.dev/reports");
    expect(response.headers.get("set-cookie")).toContain("postil_session=signed-session");
    expect(requestedUrls).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/memberships/orgs?per_page=100&state=active",
    ]);
  });
});

function callbackRequest(): Request {
  return new Request(
    "http://localhost:3000/api/auth/callback?code=github-code&state=expected-state",
    { headers: { cookie: "postil_oauth_state=expected-state" } },
  );
}

function githubUserResponse(): Response {
  return jsonResponse({
    id: 1001,
    login: "octocat",
    name: "Octo Cat",
    email: "octocat@example.com",
    avatar_url: "https://avatars.githubusercontent.com/u/1001",
  });
}

function jsonResponse(value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function assertMembershipFailure(response: Response): void {
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(
    "https://postil.dev/login?error=organization_memberships",
  );
  expect(syncCalls).toEqual([]);
  expect(reconciliationCalls).toEqual([]);
  expect(sessionCalls).toEqual([]);
}

function fakeDb(): any {
  const chain = {
    insert() {
      return chain;
    },
    values() {
      return chain;
    },
    onConflictDoUpdate() {
      return chain;
    },
    returning() {
      return Promise.resolve([{ id: 77 }]);
    },
  };
  return chain;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
