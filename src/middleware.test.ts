import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { POSTHOG_BROWSER_ORIGIN } from "./lib/posthog-config";
import { config, createCsp, middleware } from "./middleware";

describe("security middleware", () => {
  it("builds a nonce-based CSP without permissive script fallbacks", () => {
    const csp = createCsp("test-nonce");

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(csp).toContain(`connect-src 'self' ${POSTHOG_BROWSER_ORIGIN}`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    const scriptSrc = csp.split("; ").find((directive) => directive.startsWith("script-src"));
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("emits the same nonce CSP on the response and forwarded request", () => {
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000000");

    try {
      const response = middleware(new NextRequest("https://postil.dev/"));
      const nonce = btoa("00000000-0000-4000-8000-000000000000");
      const csp = createCsp(nonce);

      expect(response.headers.get("Content-Security-Policy")).toBe(csp);
      expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
      expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
      expect(response.headers.get("x-middleware-override-headers")).toBe(
        "content-security-policy,x-nonce",
      );
    } finally {
      randomUUID.mockRestore();
    }
  });

  it("does not define a static CSP that can drift from middleware", async () => {
    const headers = await nextConfig.headers?.();
    const staticHeaderKeys = headers?.flatMap((entry) =>
      entry.headers.map((header) => header.key.toLowerCase()),
    );

    expect(staticHeaderKeys).toContain("strict-transport-security");
    expect(staticHeaderKeys).not.toContain("content-security-policy");
  });

  it("matches API routes except health with the middleware CSP instead of a second policy", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig,
        url: "/api/metrics",
      }),
    ).toBe(true);
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig,
        url: "/api/health",
      }),
    ).toBe(false);
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig,
        url: "/api/healthz",
      }),
    ).toBe(true);
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig,
        url: "/api/health/check",
      }),
    ).toBe(true);
  });
});
