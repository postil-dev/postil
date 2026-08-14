import { afterEach, describe, expect, test } from "bun:test";

import {
  oauthCallbackUrl,
  organizationSettingsUrl,
  publicOrigin,
  publicRequestUrl,
  reviewDetailsUrl,
  safeReturnTarget,
} from "@/lib/oauth";

const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const mutableEnv = process.env as Record<string, string | undefined>;

afterEach(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) {
    delete process.env.POSTIL_PUBLIC_URL;
  } else {
    process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
  }
  if (ORIGINAL_NODE_ENV === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("OAuth callback URL", () => {
  test("uses POSTIL_PUBLIC_URL when configured", () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const request = new Request("http://localhost:3000/api/auth/login");

    expect(oauthCallbackUrl(request)).toBe("https://postil.dev/api/auth/callback");
  });

  test("falls back to the request origin for local development", () => {
    delete process.env.POSTIL_PUBLIC_URL;
    const request = new Request("http://localhost:3000/api/auth/login");

    expect(oauthCallbackUrl(request)).toBe("http://localhost:3000/api/auth/callback");
  });
});

describe("post-authentication return targets", () => {
  test("keeps same-site paths and queries without fragments", () => {
    expect(safeReturnTarget("/orgs/postil-dev/settings?tab=billing#private")).toBe(
      "/orgs/postil-dev/settings?tab=billing",
    );
  });

  test("rejects external, protocol-relative, auth-loop, malformed, and oversized targets", () => {
    for (const target of [
      "https://evil.example",
      "//evil.example/path",
      "/\\evil.example",
      "/login",
      "/login/retry",
      "/api/auth/login",
      "/api/webhooks/github",
      "/pricing",
      `/${"a".repeat(2_049)}`,
    ]) {
      expect(safeReturnTarget(target)).toBeUndefined();
    }
  });
});

describe("Public origin for browser-facing redirects", () => {
  test("builds a privacy-bounded dashboard run URL only from configured public data", () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    expect(reviewDetailsUrl("run-id", "customer org")).toBe(
      "https://postil.dev/orgs/customer%20org/runs/run-id",
    );
  });

  test("builds one encoded organization path segment and rejects normalized dot segments", () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    expect(organizationSettingsUrl("customer org/../billing")).toBe(
      "https://postil.dev/orgs/customer%20org%2F..%2Fbilling/settings",
    );
    expect(organizationSettingsUrl(".")).toBeUndefined();
    expect(organizationSettingsUrl("..")).toBeUndefined();
    expect(organizationSettingsUrl("x".repeat(2_048))).toBeUndefined();
  });

  test("omits dashboard run URLs when no public origin or organization is available", () => {
    delete process.env.POSTIL_PUBLIC_URL;

    expect(reviewDetailsUrl("run-id", "customer")).toBeUndefined();
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    expect(reviewDetailsUrl("run-id", null)).toBeUndefined();
  });

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

    expect(() => publicOrigin(request)).toThrow("POSTIL_PUBLIC_URL must use https");
  });

  test("requires the configured origin in production instead of trusting Host headers", () => {
    mutableEnv.NODE_ENV = "production";
    delete process.env.POSTIL_PUBLIC_URL;
    const request = new Request("http://localhost:3000/api/auth/login", {
      headers: {
        host: "evil.example",
        forwarded: "host=evil.example;proto=https",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });

    expect(() => publicOrigin(request)).toThrow("POSTIL_PUBLIC_URL is required in production");
    expect(() => publicRequestUrl(request)).toThrow(
      "POSTIL_PUBLIC_URL is required in production",
    );
  });

  test("accepts only a credential-free root HTTPS origin in production", () => {
    mutableEnv.NODE_ENV = "production";
    const request = new Request("http://localhost:3000/api/auth/login");
    const invalidOrigins = [
      "https://user:password@postil.dev",
      "https://postil.dev/admin",
      "https://postil.dev?tenant=other",
      "https://postil.dev#fragment",
      "http://postil.dev",
      "http://localhost:3000",
    ];

    for (const origin of invalidOrigins) {
      process.env.POSTIL_PUBLIC_URL = origin;
      expect(() => publicOrigin(request)).toThrow();
    }
  });

  test("allows an explicit HTTP loopback origin only outside production", () => {
    mutableEnv.NODE_ENV = "development";
    const request = new Request("http://localhost:3000/api/auth/login");

    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      process.env.POSTIL_PUBLIC_URL = origin;
      expect(publicOrigin(request)).toBe(origin);
    }
  });

  test("builds a canonical request URL without trusting forwarded headers", () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const request = new Request("http://localhost:3000/docs?utm_source=test&secret=no", {
      headers: {
        forwarded: "host=evil.example;proto=http",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });

    expect(publicRequestUrl(request).toString()).toBe(
      "https://postil.dev/docs?utm_source=test&secret=no",
    );
  });

  test("uses the request URL directly when no public origin is configured", () => {
    delete process.env.POSTIL_PUBLIC_URL;
    const request = new Request("http://localhost:3000/docs?utm_source=local");

    expect(publicRequestUrl(request).toString()).toBe(
      "http://localhost:3000/docs?utm_source=local",
    );
  });
});
