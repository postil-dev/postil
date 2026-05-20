import { describe, expect, it } from "vitest";
import { createCsp } from "./middleware";

describe("security middleware", () => {
  it("builds a nonce-based CSP without permissive script fallbacks", () => {
    const csp = createCsp("test-nonce");

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    const scriptSrc = csp.split("; ").find((directive) => directive.startsWith("script-src"));
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});
