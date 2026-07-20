import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import nextConfig from "../next.config";

const root = join(import.meta.dir, "..");

describe("PostHog deployment privacy", () => {
  test("uses direct regional ingestion with a narrowly scoped CSP", async () => {
    const rewrites = await nextConfig.rewrites?.();
    expect(rewrites).toBeUndefined();
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);

    const headers = await nextConfig.headers?.();
    const csp = headers?.[0]?.headers.find(
      (header) => header.key === "Content-Security-Policy",
    )?.value;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("connect-src 'self' https://eu.i.posthog.com");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' https://eu-assets.i.posthog.com",
    );
    expect(csp).not.toContain("/relay");
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
    expect(fly).toContain('POSTHOG_ERROR_CAPTURE = "0"');
    expect(fly).toContain('POSTHOG_LOG_CAPTURE = "0"');
    expect(fly).not.toContain("POSTHOG_SERVER_CAPTURE");
    expect(fly).toContain('POSTIL_HOSTED_INFERENCE_ENABLED = "1"');
  });

  test("does not rerun the pageview effect for query-only navigation", async () => {
    const source = await readFile(
      join(root, "src/components/posthog-pageview.tsx"),
      "utf8",
    );
    expect(source).not.toContain("useSearchParams");
    expect(source).toContain("}, [pathname]);");
  });
});
