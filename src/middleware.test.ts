import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { POSTHOG_BROWSER_ORIGIN } from "./lib/posthog-config";
import { config, createCsp, middleware } from "./middleware";

describe("security middleware", () => {
  it("builds a static-friendly CSP without permissive script fallbacks", () => {
    const csp = createCsp();

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain(`connect-src 'self' ${POSTHOG_BROWSER_ORIGIN}`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    const scriptSrc = csp.split("; ").find((directive) => directive.startsWith("script-src"));
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("emits the same CSP on the response without request header overrides", () => {
    const response = middleware(new NextRequest("https://postil.dev/"));
    const csp = createCsp();

    expect(response.headers.get("Content-Security-Policy")).toBe(csp);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeNull();
    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
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
