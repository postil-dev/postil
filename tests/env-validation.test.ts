import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { hostedInferenceEnabled, validateEnv } from "@/lib/env";

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
  "POSTIL_HOSTED_INFERENCE_ENABLED",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "POSTHOG_ERROR_CAPTURE",
  "POSTHOG_LOG_CAPTURE",
  "POSTHOG_PROJECT_TOKEN",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "POSTHOG_LOG_INFO_SAMPLE_RATE",
  "POSTHOG_LOG_MAX_PER_MINUTE",
  "POSTIL_RELEASE_SHA",
] as const;
const originalEnv = new Map(
  MANAGED_ENV.map((name) => [name, process.env[name]]),
);
const mutableEnv = process.env as Record<string, string | undefined>;

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete mutableEnv[name];
    else mutableEnv[name] = value;
  }
});

describe("worker startup environment validation", () => {
  test("accepts only explicit binary hosted inference switch values", () => {
    configureRequiredWorkerEnvironment();
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    expect(() => validateEnv("worker")).not.toThrow();
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    expect(() => validateEnv("worker")).not.toThrow();
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "false";
    expect(() => validateEnv("worker")).toThrow(/must be 0 or 1/);
  });

  test("keeps hosted inference enabled by default and honors an explicit pause", () => {
    delete process.env.POSTIL_HOSTED_INFERENCE_ENABLED;
    expect(hostedInferenceEnabled()).toBe(true);
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    expect(hostedInferenceEnabled()).toBe(false);
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    expect(hostedInferenceEnabled()).toBe(true);
  });

  test("disables hosted inference in the managed deployment and verifies every worker", async () => {
    const root = join(import.meta.dir, "..");
    const [flyConfig, deployWorkflow] = await Promise.all([
      readFile(join(root, "fly.toml"), "utf8"),
      readFile(join(root, ".github/workflows/deploy.yml"), "utf8"),
    ]);

    expect(flyConfig).toContain('POSTIL_HOSTED_INFERENCE_ENABLED = "0"');
    expect(deployWorkflow).toContain(
      ".config.env.POSTIL_HOSTED_INFERENCE_ENABLED",
    );
    expect(deployWorkflow).toContain(
      `worker_hosted_inference_modes}" != '["0"]'`,
    );
  });
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

  test("does not include malformed public URL input in startup errors", () => {
    configureRequiredWebEnvironment();
    mutableEnv.NODE_ENV = "production";
    process.env.POSTIL_PUBLIC_URL = "https://operator:credential@[invalid";

    let message = "";
    try {
      validateEnv("web");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Postil web cannot start: invalid POSTIL_PUBLIC_URL.");
    expect(message).not.toContain("operator");
    expect(message).not.toContain("credential");
  });

  test("requires a project token when operational telemetry is enabled", () => {
    configureRequiredWebEnvironment();
    process.env.POSTHOG_ERROR_CAPTURE = "1";
    delete process.env.POSTHOG_PROJECT_TOKEN;

    expect(() => validateEnv("web")).toThrow(/requires POSTHOG_PROJECT_TOKEN/);
  });

  test("rejects unsafe or malformed operational telemetry settings", () => {
    configureRequiredWebEnvironment();
    mutableEnv.NODE_ENV = "production";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTHOG_LOG_CAPTURE = "1";
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "http://posthog.invalid/path";

    expect(() => validateEnv("web")).toThrow(/credential-free HTTPS origin/);

    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
    process.env.POSTHOG_LOG_INFO_SAMPLE_RATE = "1.1";
    expect(() => validateEnv("web")).toThrow(/must be between 0 and 1/);

    process.env.POSTHOG_LOG_INFO_SAMPLE_RATE = "0.01";
    process.env.POSTHOG_LOG_MAX_PER_MINUTE = "0";
    expect(() => validateEnv("web")).toThrow(/must be a positive integer/);

    process.env.POSTHOG_LOG_MAX_PER_MINUTE = "60";
    process.env.POSTIL_RELEASE_SHA = "release-main";
    expect(() => validateEnv("web")).toThrow(/hexadecimal commit SHA/);
  });

  test("accepts bounded operational telemetry settings", () => {
    configureRequiredWebEnvironment();
    mutableEnv.NODE_ENV = "production";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTHOG_ERROR_CAPTURE = "1";
    process.env.POSTHOG_LOG_CAPTURE = "1";
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
    process.env.POSTHOG_LOG_INFO_SAMPLE_RATE = "0.01";
    process.env.POSTHOG_LOG_MAX_PER_MINUTE = "60";
    process.env.POSTIL_RELEASE_SHA = "0123456789abcdef";

    expect(() => validateEnv("web")).not.toThrow();
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

function configureRequiredWorkerEnvironment(): void {
  process.env.DATABASE_URL = "postgres://postil:postil@localhost:5432/postil";
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  process.env.POSTIL_SEALING_KEY = "00".repeat(32);
}
