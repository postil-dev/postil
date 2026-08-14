import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";

import * as dbModule from "@/lib/db";
import { fetchAllActiveOrgMemberships } from "@/lib/github/user-memberships";

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
const setupDestinationCalls: Array<{ userId: number; installationId: string | undefined }> = [];
const reconciliationCalls: Array<{ userId: number; accounts: AccountMembership[] }> = [];
const sessionCalls: Array<{
  userId: number;
  accessToken: string;
  membershipCheckedAt: Date;
}> = [];
const requestedUrls: string[] = [];
const requestedSignals: AbortSignal[] = [];
let githubResponses: Array<Response | Error> = [];
let setupOrgSlug: string | undefined;

mock.module("@/lib/db", () => ({
  ...dbModule,
  getDb: () => fakeDb(),
}));

mock.module("@/lib/github/installation-sync", () => ({
  syncInstallationsFromGithub: async (accounts: AccountRef[]) => {
    syncCalls.push(accounts);
  },
  findAccessibleInstallationOrgSlug: async (
    userId: number,
    installationId: string | undefined,
  ) => {
    setupDestinationCalls.push({ userId, installationId });
    return setupOrgSlug;
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
  refreshUserMembershipsForOAuth: async ({
    userId,
    githubId,
    accessToken,
    onFetchedMemberships,
  }: {
    userId: number;
    githubId: number;
    accessToken: string;
    onFetchedMemberships: (
      memberships: Array<{
        role?: string;
        organization?: { id?: number; login?: string };
      }>,
    ) => Promise<void>;
  }) => {
    const result = await fetchAllActiveOrgMemberships(accessToken);
    if (!result.ok) {
      return {
        ok: false,
        reason:
          result.reason === "unauthorized"
            ? "unauthenticated"
            : "verification_unavailable",
      };
    }
    await onFetchedMemberships(result.memberships);
    reconciliationCalls.push({
      userId,
      accounts: [
        { githubOrgId: githubId, role: "admin" },
        ...result.memberships.flatMap((membership) => {
          const orgId = membership.organization?.id;
          return typeof orgId === "number"
            ? [
                {
                  githubOrgId: orgId,
                  role: membership.role === "admin" ? "admin" : "member",
                },
              ]
            : [];
        }),
      ],
    });
    return { ok: true, checkedAt: new Date() };
  },
  SESSION_TTL_SECONDS: 7 * 24 * 60 * 60,
}));

const { GET } = await import("@/app/api/auth/callback/route");

beforeEach(() => {
  process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
  process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-client-secret";
  syncCalls.length = 0;
  setupDestinationCalls.length = 0;
  reconciliationCalls.length = 0;
  sessionCalls.length = 0;
  requestedUrls.length = 0;
  requestedSignals.length = 0;
  githubResponses = [];
  setupOrgSlug = undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrls.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (init?.signal) requestedSignals.push(init.signal);
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
  test("preserves the return target when token exchange has a network failure", async () => {
    githubResponses = [new Error("network unavailable")];

    assertLoginFailure(
      await GET(callbackRequest(returnTargetCookie())),
      "token_exchange",
    );
    expect(requestedSignals).toHaveLength(1);
  });

  test("preserves the return target when token exchange times out", async () => {
    githubResponses = [new DOMException("request timed out", "TimeoutError")];

    assertLoginFailure(
      await GET(callbackRequest(returnTargetCookie())),
      "token_exchange",
    );
    expect(requestedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  test("times out while reading a stalled token response body", async () => {
    jest.useFakeTimers();
    try {
      globalThis.fetch = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected an OAuth timeout signal");
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              );
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;

      const pending = GET(callbackRequest(returnTargetCookie()));
      await Promise.resolve();
      jest.advanceTimersByTime(10_000);

      assertLoginFailure(await pending, "token_exchange");
    } finally {
      jest.useRealTimers();
    }
  });

  test("preserves the return target for malformed and invalid token responses", async () => {
    githubResponses = [
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    assertLoginFailure(
      await GET(callbackRequest(returnTargetCookie())),
      "token_exchange",
    );

    githubResponses = [jsonResponse({ access_token: 42 })];
    assertLoginFailure(
      await GET(callbackRequest(returnTargetCookie())),
      "token_exchange",
    );
  });

  test("preserves the return target when token exchange returns a non-success status", async () => {
    githubResponses = [new Response("unavailable", { status: 503 })];

    assertLoginFailure(
      await GET(callbackRequest(returnTargetCookie())),
      "token_exchange",
    );
  });

  test("preserves the return target when the profile request has a network or timeout failure", async () => {
    for (const failure of [
      new Error("network unavailable"),
      new DOMException("request timed out", "TimeoutError"),
    ]) {
      githubResponses = [jsonResponse({ access_token: "user-access-token" }), failure];
      assertLoginFailure(
        await GET(callbackRequest(returnTargetCookie())),
        "profile",
      );
    }
  });

  test("preserves the return target for malformed and invalid profile responses", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    assertLoginFailure(
      await GET(callbackRequest(returnTargetCookie())),
      "profile",
    );

    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      jsonResponse({ id: 1001, login: null }),
    ];
    assertLoginFailure(
      await GET(callbackRequest(returnTargetCookie())),
      "profile",
    );
  });

  test("preserves the return target when the profile request returns a non-success status", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      new Response("unavailable", { status: 503 }),
    ];

    assertLoginFailure(
      await GET(callbackRequest(returnTargetCookie())),
      "profile",
    );
  });

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
    expect(setupDestinationCalls).toEqual([{ userId: 77, installationId: undefined }]);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://postil.dev/reports");
    expect(response.headers.get("set-cookie")).toContain("postil_session=signed-session");
    expect(requestedUrls).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/memberships/orgs?per_page=100&state=active",
    ]);
  });

  test("lands a setup flow on the installed account after authorization", async () => {
    setupOrgSlug = "example-org";
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      jsonResponse([]),
    ];

    const response = await GET(
      callbackRequest("postil_setup_installation=42424242"),
    );

    expect(setupDestinationCalls).toEqual([
      { userId: 77, installationId: "42424242" },
    ]);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/orgs/example-org",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "postil_setup_installation=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });

  test("returns to an exact run detail path and query after authorization", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      jsonResponse([]),
    ];

    const response = await GET(
      callbackRequest(
        returnTargetCookie(),
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://postil.dev/orgs/example-org/runs/11111111-2222-4333-8444-555555555555?tab=findings",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "postil_oauth_return_to=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });

  test("prioritizes a safe return target over a setup installation cookie", async () => {
    setupOrgSlug = "stale-setup-org";
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      jsonResponse([]),
    ];

    const response = await GET(
      callbackRequest(
        `${returnTargetCookie()}; postil_setup_installation=42424242`,
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://postil.dev/orgs/example-org/runs/11111111-2222-4333-8444-555555555555?tab=findings",
    );
    expect(setupDestinationCalls).toEqual([]);
  });

  test("sets the browser session cookie for seven days", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      jsonResponse([]),
    ];

    const response = await GET(callbackRequest());

    expect(response.headers.get("set-cookie")).toContain("Max-Age=604800");
  });

  test("ignores a forged external return cookie", async () => {
    githubResponses = [
      jsonResponse({ access_token: "user-access-token" }),
      githubUserResponse(),
      jsonResponse([]),
    ];

    const response = await GET(
      callbackRequest("postil_oauth_return_to=https%3A%2F%2Fevil.example%2Faccount"),
    );

    expect(response.headers.get("location")).toBe("https://postil.dev/reports");
  });
});

function callbackRequest(extraCookie?: string): Request {
  return new Request(
    "http://localhost:3000/api/auth/callback?code=github-code&state=expected-state",
    {
      headers: {
        cookie: ["postil_oauth_state=expected-state", extraCookie]
          .filter(Boolean)
          .join("; "),
      },
    },
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

function returnTargetCookie(): string {
  return "postil_oauth_return_to=%2Forgs%2Fexample-org%2Fruns%2F11111111-2222-4333-8444-555555555555%3Ftab%3Dfindings";
}

function assertLoginFailure(response: Response, error: string): void {
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(
    `https://postil.dev/login?error=${error}&next=%2Forgs%2Fexample-org%2Fruns%2F11111111-2222-4333-8444-555555555555%3Ftab%3Dfindings`,
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
