import { beforeEach, describe, expect, mock, test } from "bun:test";

import { schema as databaseSchema } from "@/lib/db";

const ACCESS_TOKEN = `pcli_${"a".repeat(43)}`;
const REFRESH_TOKEN = `pclr_${"b".repeat(43)}`;
const REPLACEMENT_ACCESS_TOKEN = `pcli_${"c".repeat(43)}`;
const REPLACEMENT_REFRESH_TOKEN = `pclr_${"d".repeat(43)}`;
const ACCESS_EXPIRES_AT = new Date("2030-01-01T12:00:00.000Z");
const REFRESH_EXPIRES_AT = new Date("2030-06-30T12:00:00.000Z");

let refreshResult:
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | {
      status: "approved";
      token: string;
      expiresAt: Date;
      refreshToken: string;
      refreshExpiresAt: Date;
    };
let refreshInputs: string[] = [];
let revokedCredentials: Array<{ accessToken?: string; refreshToken?: string }> =
  [];
let deviceCodeInputs: string[] = [];
let deviceIssuerInputs: string[] = [];

mock.module("@/lib/db", () => ({
  schema: databaseSchema,
  getPool: () => ({}),
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { slug: "cli-contract-org", name: "CLI Contract Org" },
          ],
        }),
      }),
    }),
  }),
}));

mock.module("@/lib/cli-auth", () => ({
  bearerCliToken: (header: string | null) => {
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    return /^pcli_[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  },
  isCliRefreshToken: (value: unknown) =>
    typeof value === "string" && /^pclr_[A-Za-z0-9_-]{43}$/.test(value),
  readCliJsonBody: async (request: Request) => {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 4 * 1_024) {
      return { ok: false as const, status: 413 as const };
    }
    if (!text) return { ok: true as const, body: null };
    try {
      return { ok: true as const, body: JSON.parse(text) };
    } catch {
      return { ok: false as const, status: 400 as const };
    }
  },
  claimDeviceAuthorizationToken: async (
    _db: unknown,
    deviceCode: string,
    issuer: string,
  ) => {
    deviceCodeInputs.push(deviceCode);
    deviceIssuerInputs.push(issuer);
    return {
      status: "approved" as const,
      token: ACCESS_TOKEN,
      expiresAt: ACCESS_EXPIRES_AT,
      refreshToken: REFRESH_TOKEN,
      refreshExpiresAt: REFRESH_EXPIRES_AT,
      userId: 1,
      orgId: 2,
    };
  },
  refreshCliSession: async (_db: unknown, refreshToken: string) => {
    refreshInputs.push(refreshToken);
    return refreshResult;
  },
  revokeCliCredentials: async (
    _db: unknown,
    input: { accessToken?: string; refreshToken?: string },
  ) => {
    revokedCredentials.push(input);
  },
}));

mock.module("@/lib/cli-gateway", () => ({
  resolveHostedGatewayDefaultModel: async () => "z-ai/glm-5.2",
}));

const { POST: deviceTokenPost } =
  await import("@/app/api/cli/device/token/route");
const { POST: refreshPost } = await import("@/app/api/cli/token/refresh/route");
const { POST: logoutPost } = await import("@/app/api/cli/logout/route");

describe("CLI refresh routes", () => {
  beforeEach(() => {
    refreshResult = {
      status: "approved",
      token: REPLACEMENT_ACCESS_TOKEN,
      expiresAt: ACCESS_EXPIRES_AT,
      refreshToken: REPLACEMENT_REFRESH_TOKEN,
      refreshExpiresAt: REFRESH_EXPIRES_AT,
    };
    refreshInputs = [];
    revokedCredentials = [];
    deviceCodeInputs = [];
    deviceIssuerInputs = [];
  });

  test("returns a replacement credential pair with no-store caching", async () => {
    const response = await refreshPost(refreshRequest(REFRESH_TOKEN));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      token: REPLACEMENT_ACCESS_TOKEN,
      expiresAt: ACCESS_EXPIRES_AT.toISOString(),
      refreshToken: REPLACEMENT_REFRESH_TOKEN,
      refreshExpiresAt: REFRESH_EXPIRES_AT.toISOString(),
    });
    expect(refreshInputs).toEqual([REFRESH_TOKEN]);
  });

  test("does not distinguish an expired, revoked, or replayed refresh credential", async () => {
    refreshResult = { status: "invalid" };
    const response = await refreshPost(refreshRequest(REFRESH_TOKEN));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: { message: "postil login required", type: "invalid_token" },
    });
  });

  test("returns the governed family cadence as a retryable rate limit", async () => {
    refreshResult = { status: "rate_limited", retryAfterSeconds: 3_527 };
    const response = await refreshPost(refreshRequest(REFRESH_TOKEN));

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("retry-after")).toBe("3527");
    expect(await response.json()).toEqual({
      error: {
        message: "CLI session refresh is not available yet",
        type: "rate_limited",
      },
    });
  });

  test("rejects malformed refresh bodies before touching session storage", async () => {
    const response = await refreshPost(
      new Request("https://postil.dev/api/cli/token/refresh", {
        method: "POST",
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(refreshInputs).toEqual([]);
  });

  test("logout accepts either credential and passes both when supplied", async () => {
    const refreshOnly = await logoutPost(
      new Request("https://postil.dev/api/cli/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: REFRESH_TOKEN }),
      }),
    );
    const both = await logoutPost(
      new Request("https://postil.dev/api/cli/logout", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ACCESS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ refreshToken: REFRESH_TOKEN }),
      }),
    );

    expect(refreshOnly.status).toBe(204);
    expect(both.status).toBe(204);
    expect(refreshOnly.headers.get("cache-control")).toBe("private, no-store");
    expect(revokedCredentials).toEqual([
      { refreshToken: REFRESH_TOKEN },
      { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN },
    ]);
  });

  test("logout retains the authorization-only legacy contract", async () => {
    const response = await logoutPost(
      new Request("https://postil.dev/api/cli/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      }),
    );

    expect(response.status).toBe(204);
    expect(revokedCredentials).toEqual([{ accessToken: ACCESS_TOKEN }]);
  });

  test("logout rejects malformed bodies without revoking a credential", async () => {
    const response = await logoutPost(
      new Request("https://postil.dev/api/cli/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(revokedCredentials).toEqual([]);
  });

  test("device approval response stays compatible and adds refresh credentials", async () => {
    const response = await deviceTokenPost(
      new Request("https://postil.dev/api/cli/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: "device-code" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      status: "approved",
      token: ACCESS_TOKEN,
      expiresAt: ACCESS_EXPIRES_AT.toISOString(),
      refreshToken: REFRESH_TOKEN,
      refreshExpiresAt: REFRESH_EXPIRES_AT.toISOString(),
      apiBase: "https://postil.dev/api/inference/v1",
      org: { slug: "cli-contract-org", name: "CLI Contract Org" },
      model: "z-ai/glm-5.2",
    });
    expect(deviceCodeInputs).toEqual(["device-code"]);
    expect(deviceIssuerInputs).toEqual(["https://postil.dev"]);
  });

  test("device token polling preserves malformed and oversized body statuses", async () => {
    const malformed = await deviceTokenPost(
      new Request("https://postil.dev/api/cli/device/token", {
        method: "POST",
        body: "{",
      }),
    );
    const oversized = await deviceTokenPost(
      new Request("https://postil.dev/api/cli/device/token", {
        method: "POST",
        body: JSON.stringify({ deviceCode: "x".repeat(4 * 1_024) }),
      }),
    );

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(deviceCodeInputs).toEqual([]);
  });
});

function refreshRequest(refreshToken: string): Request {
  return new Request("https://postil.dev/api/cli/token/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
}
