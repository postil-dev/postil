import { afterEach, describe, expect, test } from "bun:test";

import { validateEnv } from "@/lib/env";

const MANAGED_ENV = [
  "DATABASE_URL",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "NODE_ENV",
  "POSTIL_PUBLIC_URL",
  "POSTIL_SEALING_KEY",
  "POSTIL_SESSION_SECRET",
  "POSTIL_WEBHOOK_DRAIN_ENABLED",
] as const;
const originalEnv = new Map(MANAGED_ENV.map((name) => [name, process.env[name]]));
const mutableEnv = process.env as Record<string, string | undefined>;

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete mutableEnv[name];
    else mutableEnv[name] = value;
  }
});

describe("web startup environment validation", () => {
  test("requires POSTIL_PUBLIC_URL in production", () => {
    configureRequiredWebEnvironment();
    mutableEnv.NODE_ENV = "production";
    delete process.env.POSTIL_PUBLIC_URL;

    expect(() => validateEnv("web")).toThrow(/POSTIL_PUBLIC_URL/);
  });

  test("retains request-origin fallback for local development startup", () => {
    configureRequiredWebEnvironment();
    mutableEnv.NODE_ENV = "development";
    delete process.env.POSTIL_PUBLIC_URL;

    expect(() => validateEnv("web")).not.toThrow();
  });

  test("rejects an invalid configured public origin during startup", () => {
    configureRequiredWebEnvironment();
    mutableEnv.NODE_ENV = "production";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev/tenant";

    expect(() => validateEnv("web")).toThrow(
      /cannot start: invalid POSTIL_PUBLIC_URL.*without a path, query, or fragment/,
    );
  });
});

function configureRequiredWebEnvironment(): void {
  process.env.DATABASE_URL = "postgres://postil:postil@localhost:5432/postil";
  process.env.POSTIL_SESSION_SECRET = "test-session-secret-at-least-32-bytes";
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret-at-least-32-bytes";
  process.env.GITHUB_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.POSTIL_SEALING_KEY = "00".repeat(32);
  process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "0";
}
