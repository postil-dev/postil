import { afterEach, describe, expect, mock, test } from "bun:test";

import { SESSION_COOKIE, signSessionToken } from "@/lib/session-token";

const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;
const ORIGINAL_SESSION_SECRET = process.env.POSTIL_SESSION_SECRET;
const SESSION_SECRET = "session-secret-for-logout-tests";
const destroyedTokens: string[] = [];

mock.module("@/lib/session", () => ({
  SESSION_COOKIE,
  destroySessionByToken: async (token: string | undefined) => {
    if (token) destroyedTokens.push(token);
  },
}));

const { POST } = await import("@/app/api/auth/logout/route");

afterEach(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.POSTIL_PUBLIC_URL;
  else process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;

  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.POSTIL_SESSION_SECRET;
  else process.env.POSTIL_SESSION_SECRET = ORIGINAL_SESSION_SECRET;

  destroyedTokens.length = 0;
});

describe("POST /api/auth/logout", () => {
  test("rejects cross-origin form posts", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const response = await POST(
      new Request("https://postil.dev/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://evil.test" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  test("allows form posts without origin when fetch metadata is absent", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTIL_SESSION_SECRET = SESSION_SECRET;
    const token = await validSessionToken();

    const response = await POST(
      new Request("https://postil.dev/api/auth/logout", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://postil.dev/");
    expect(response.headers.get("set-cookie")).toContain("postil_session=");
    expect(destroyedTokens).toEqual([token]);
  });

  test("allows same-origin form posts and clears the session cookie", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTIL_SESSION_SECRET = SESSION_SECRET;
    const token = await validSessionToken();

    const response = await POST(
      new Request("https://postil.dev/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "https://postil.dev",
          cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://postil.dev/");
    expect(response.headers.get("set-cookie")).toContain("postil_session=");
    expect(destroyedTokens).toEqual([token]);
  });

  test("rejects missing or malformed session cookies without logging token values", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const malformedToken = "not-a-session-token";
    const logged: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const missingResponse = await POST(logoutRequest({ cookie: undefined }));
      const emptyResponse = await POST(logoutRequest({ cookie: `${SESSION_COOKIE}=` }));
      const malformedResponse = await POST(
        logoutRequest({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(malformedToken)}` }),
      );

      for (const response of [missingResponse, emptyResponse, malformedResponse]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_session" });
        expect(response.headers.get("set-cookie")).toContain("postil_session=");
      }
      expect(destroyedTokens).toEqual([]);
      expect(logged.join("\n")).toContain("logout rejected invalid session cookie");
      expect(logged.join("\n")).not.toContain(malformedToken);
    } finally {
      console.warn = realWarn;
    }
  });
});

async function validSessionToken(): Promise<string> {
  return signSessionToken("a".repeat(43), SESSION_SECRET);
}

function logoutRequest({ cookie }: { cookie: string | undefined }): Request {
  const headers = new Headers({ origin: "https://postil.dev" });
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request("https://postil.dev/api/auth/logout", { method: "POST", headers });
}
