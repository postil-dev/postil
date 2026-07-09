import { afterEach, describe, expect, test } from "bun:test";

import { oauthCallbackUrl, publicOrigin } from "@/lib/oauth";

const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;

afterEach(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) {
    delete process.env.POSTIL_PUBLIC_URL;
  } else {
    process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
  }
});

describe("OAuth callback URL", () => {
  test("uses POSTIL_PUBLIC_URL when configured", () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev/some/path";

    const request = new Request("http://localhost:3000/api/auth/login");

    expect(oauthCallbackUrl(request)).toBe("https://postil.dev/api/auth/callback");
  });

  test("falls back to the request origin for local development", () => {
    delete process.env.POSTIL_PUBLIC_URL;
    const request = new Request("http://localhost:3000/api/auth/login");

    expect(oauthCallbackUrl(request)).toBe("http://localhost:3000/api/auth/callback");
  });
});

describe("Public origin for browser-facing redirects", () => {
  test("uses POSTIL_PUBLIC_URL, ignoring the proxy-internal request origin", () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const request = new Request("https://localhost:3000/api/auth/callback?code=x&state=y");

    expect(publicOrigin(request)).toBe("https://postil.dev");
    expect(new URL("/reports", publicOrigin(request)).toString()).toBe(
      "https://postil.dev/reports",
    );
  });

  test("falls back to the request origin for local development", () => {
    delete process.env.POSTIL_PUBLIC_URL;

    const request = new Request("http://localhost:3000/api/auth/logout");

    expect(publicOrigin(request)).toBe("http://localhost:3000");
  });

  test("rejects a non-http POSTIL_PUBLIC_URL", () => {
    process.env.POSTIL_PUBLIC_URL = "ftp://postil.dev";

    const request = new Request("http://localhost:3000/api/auth/login");

    expect(() => publicOrigin(request)).toThrow("POSTIL_PUBLIC_URL must use http or https");
  });
});
