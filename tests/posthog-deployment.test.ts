import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import nextConfig from "../next.config";

const root = join(import.meta.dir, "..");

describe("PostHog deployment privacy", () => {
  test("uses a fixed same-origin relay and a first-party-only CSP", async () => {
    const rewrites = await nextConfig.rewrites?.();
    expect(rewrites).toEqual([
      {
        source: "/relay/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/relay/array/:path*",
        destination: "https://eu-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/relay/i/v0/e/:path*",
        destination: "https://eu.i.posthog.com/i/v0/e/:path*",
      },
      {
        source: "/relay/e/:path*",
        destination: "https://eu.i.posthog.com/e/:path*",
      },
    ]);
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);

    const headers = await nextConfig.headers?.();
    const csp = headers?.[0]?.headers.find(
      (header) => header.key === "Content-Security-Policy",
    )?.value;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("i.posthog.com");
    expect(csp).not.toContain("assets.i.posthog.com");
  });

  test("does not bake the project token into browser build artifacts", async () => {
    const [dockerfile, compose, deploy, fly] = await Promise.all([
      readFile(join(root, "Dockerfile"), "utf8"),
      readFile(join(root, "docker-compose.yml"), "utf8"),
      readFile(join(root, ".github/workflows/deploy.yml"), "utf8"),
      readFile(join(root, "fly.toml"), "utf8"),
    ]);
    expect(dockerfile).not.toContain("NEXT_PUBLIC_POSTHOG_KEY");
    expect(compose).not.toContain("NEXT_PUBLIC_POSTHOG_KEY");
    expect(deploy).not.toContain("--build-arg NEXT_PUBLIC_POSTHOG_KEY");
    expect(fly).toContain('POSTHOG_CLIENT_CAPTURE = "1"');
  });
});
