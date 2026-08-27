import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  configuredWorkerHeartbeatIntervalMs,
  hostedInferenceEnabled,
  validateEnv,
} from "@/lib/env";

const MANAGED_ENV = [
  "DATABASE_URL",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "POSTIL_ILERT_WEBHOOK_SECRET",
  "NODE_ENV",
  "POSTIL_PUBLIC_URL",
  "POSTIL_SEALING_KEY",
  "POSTIL_SESSION_SECRET",
  "POSTIL_WEBHOOK_DRAIN_ENABLED",
  "POSTIL_HOSTED_INFERENCE_ENABLED",
  "POSTIL_PROVISIONAL_HOSTED_ROSTER",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "POSTHOG_ERROR_CAPTURE",
  "POSTHOG_LOG_CAPTURE",
  "POSTHOG_PROJECT_TOKEN",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "POSTHOG_LOG_INFO_SAMPLE_RATE",
  "POSTHOG_LOG_MAX_PER_MINUTE",
  "POSTIL_RELEASE_SHA",
  "POSTIL_OPERATOR_ALERT_EMAIL",
  "BREVO_API_KEY",
  "WORKER_HEARTBEAT_INTERVAL_MS",
  "POSTIL_MONITOR_ALERT_STATE_PATH",
  "OPENROUTER_MANAGEMENT_API_KEY",
  "POSTIL_OPENROUTER_DEVELOPMENT_KEY_NAME",
  "POSTIL_OPENROUTER_PRODUCTION_KEY_NAME",
  "POSTIL_OPENROUTER_EMERGENCY_KEY_NAME",
  "POSTIL_OPENROUTER_REVIEW_OUTAGE_THRESHOLD_USD",
  "POSTIL_PADDLE_BILLING_ENABLED",
  "PADDLE_API_KEY",
  "PADDLE_WEBHOOK_SECRET",
  "PADDLE_CLIENT_TOKEN",
  "PADDLE_ZERO_BASE_PRICE_ID",
  "PADDLE_ACTIVE_AUTHOR_PRICE_ID",
  "PADDLE_ENVIRONMENT",
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
  test("keeps worker heartbeats disabled until explicitly configured", () => {
    delete process.env.WORKER_HEARTBEAT_INTERVAL_MS;
    expect(configuredWorkerHeartbeatIntervalMs()).toBeNull();
    process.env.WORKER_HEARTBEAT_INTERVAL_MS = "30000";
    expect(configuredWorkerHeartbeatIntervalMs()).toBe(30_000);
    process.env.WORKER_HEARTBEAT_INTERVAL_MS = "1000";
    expect(() => configuredWorkerHeartbeatIntervalMs()).toThrow(
      /between 30000 and 3600000/,
    );
  });

  test("accepts only explicit binary hosted inference switch values", () => {
    configureRequiredWorkerEnvironment();
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    expect(() => validateEnv("worker")).not.toThrow();
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    expect(() => validateEnv("worker")).not.toThrow();
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "false";
    expect(() => validateEnv("worker")).toThrow(/must be 0 or 1/);
  });

  test("accepts only explicit provisional roster switch values", () => {
    configureRequiredWorkerEnvironment();
    process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = "0";
    expect(() => validateEnv("worker")).not.toThrow();
    process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = "1";
    expect(() => validateEnv("worker")).not.toThrow();
    process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = "true";
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

  test("enables the provisional hosted roster in the managed deployment and verifies every worker", async () => {
    const root = join(import.meta.dir, "..");
    const [flyConfig, deployWorkflow] = await Promise.all([
      readFile(join(root, "fly.toml"), "utf8"),
      readFile(join(root, ".github/workflows/deploy.yml"), "utf8"),
    ]);

    expect(flyConfig).toContain('POSTIL_HOSTED_INFERENCE_ENABLED = "1"');
    expect(flyConfig).toContain('POSTIL_PROVISIONAL_HOSTED_ROSTER = "1"');
    expect(flyConfig).toContain('source = "postil_monitor_state"');
    expect(flyConfig).toContain('destination = "/var/lib/postil-monitor"');
    expect(flyConfig).toContain('processes = ["monitor"]');
    expect(deployWorkflow).toContain(
      "flyctl volumes create postil_monitor_state",
    );
    expect(deployWorkflow).toContain(
      "Private monitor is not using the provisioned durable state volume.",
    );
    expect(deployWorkflow).toContain(
      "jq -ce -f scripts/verify-managed-fleet.jq",
    );
    expect(deployWorkflow).toContain(
      'flyctl ssh console --app postil-web --command "bun run hosted:verify-provider"',
    );
    expect(deployWorkflow.indexOf("bun run hosted:verify-provider")).toBeLessThan(
      deployWorkflow.indexOf("bun run jobs:activate-release"),
    );
    expect(flyConfig).toContain('POSTIL_HOSTED_INFERENCE_ENABLED = "1"');
    expect(deployWorkflow).toMatch(
      /- name: Deploy managed fleet\n\s+id: deploy\n\s+timeout-minutes: 10/,
    );
    expect(deployWorkflow).toContain(
      "always() && steps.deploy.outcome != 'skipped'",
    );
    expect(deployWorkflow).toContain("restart_failed=0");
    expect(deployWorkflow).toContain("restart_failed=1");
    expect(deployWorkflow.indexOf('if [ "${restart_failed}" -ne 0 ]')).toBeGreaterThan(
      deployWorkflow.indexOf("restart_failed=1"),
    );
    expect(deployWorkflow).not.toContain("flyctl logs");
    expect(deployWorkflow).not.toContain("Collect failed rollout diagnostics");
    expect(deployWorkflow).toContain(
      "fly_secrets=$(flyctl secrets list --json)",
    );
    expect(deployWorkflow).not.toContain("done < <(flyctl secrets list --json");
    expect(deployWorkflow).toContain(
      "POSTIL_HOSTED_INFERENCE_ENABLED|POSTIL_PROVISIONAL_HOSTED_ROSTER|REVIEW_MODEL|REVIEW_MODEL_CASCADE",
    );
    expect(deployWorkflow).toContain(
      "The provisional hosted roster requires postil-cli v0.7.0 or newer.",
    );
    expect(deployWorkflow).toContain(
      'flyctl secrets unset --stage "${runtime_override_secrets[@]}"',
    );
    expect(deployWorkflow).toContain("monitor_secret_names=(");
    expect(deployWorkflow).toContain("OPENROUTER_MANAGEMENT_API_KEY");
    expect(deployWorkflow).toContain("POSTIL_OPENROUTER_DEVELOPMENT_KEY_NAME");
    expect(deployWorkflow).toContain("POSTIL_OPENROUTER_PRODUCTION_KEY_NAME");
    expect(deployWorkflow).toContain("POSTIL_OPENROUTER_EMERGENCY_KEY_NAME");
    expect(deployWorkflow).toContain('if [[ -n "${value}" ]]; then');
    expect(deployWorkflow).not.toContain(
      'Infisical did not provide ${name}',
    );
    const monitorSecretBlock = deployWorkflow.slice(
      deployWorkflow.indexOf("monitor_secret_names=("),
      deployWorkflow.indexOf("paddle_secret_names=("),
    );
    expect(monitorSecretBlock).toContain('if [[ -n "${value}" ]]; then');
    expect(monitorSecretBlock).not.toContain("exit 1");
    const failedSecretList = Bun.spawnSync(
      [
        "bash",
        "-c",
        "set -euo pipefail; flyctl() { return 37; }; fly_secrets=$(flyctl secrets list --json); printf continued",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    expect(failedSecretList.exitCode).toBe(37);
    expect(failedSecretList.stdout.toString()).toBe("");

    const validFleet = [
      managedMachine("web", "1", "1"),
      managedMachine("web", "1", "1"),
      managedMachine("worker", "1", "1"),
      managedMachine("monitor"),
    ];
    expect(verifyManagedFleet(root, validFleet).exitCode).toBe(0);
    expect(
      verifyManagedFleet(root, [...validFleet, managedMachine("worker", "0", "1")])
        .exitCode,
    ).not.toBe(0);
    expect(
      verifyManagedFleet(root, [
        managedMachine("web", "1", "1"),
        managedMachine("web", "1", "1"),
        managedMachine("worker", "1", "1"),
        managedMachine("monitor", undefined, undefined, "started", undefined, []),
      ]).exitCode,
    ).not.toBe(0);
    expect(
      verifyManagedFleet(root, [...validFleet, managedMachine("worker", "1", "0")])
        .exitCode,
    ).not.toBe(0);
    expect(
      verifyManagedFleet(root, [
        managedMachine("web", "1", "1"),
        managedMachine(
          "web",
          undefined,
          undefined,
          "started",
          "registry.fly.io/postil-web:other",
        ),
        managedMachine("worker", "1", "1"),
        managedMachine("monitor"),
      ]).exitCode,
    ).not.toBe(0);
    expect(
      verifyManagedFleet(root, [
        ...validFleet,
        managedMachine("worker", "0", "1", "stopped"),
      ]).exitCode,
    ).not.toBe(0);
    expect(
      verifyManagedFleet(root, [
        managedMachine("web", "0", "1"),
        managedMachine("web", "0", "1"),
        managedMachine("worker"),
        managedMachine("monitor"),
      ]).exitCode,
    ).not.toBe(0);
    expect(
      verifyManagedFleet(root, [
        managedMachine("web", "0", "1"),
        managedMachine("web", "0", "1"),
      ]).exitCode,
    ).not.toBe(0);
  });

  test("typechecks deploy source before the remote image build", async () => {
    const root = join(import.meta.dir, "..");
    const [deployWorkflow, dockerfile, nextConfig] = await Promise.all([
      readFile(join(root, ".github/workflows/deploy.yml"), "utf8"),
      readFile(join(root, "Dockerfile"), "utf8"),
      readFile(join(root, "next.config.ts"), "utf8"),
    ]);

    const typecheck = deployWorkflow.indexOf("- name: Verify deploy source types");
    const secrets = deployWorkflow.indexOf("- name: Load deployment secrets");
    const deploy = deployWorkflow.indexOf("- name: Deploy managed fleet");
    expect(typecheck).toBeGreaterThan(-1);
    expect(deployWorkflow.slice(typecheck, secrets)).toContain(
      "bun install --frozen-lockfile",
    );
    expect(deployWorkflow.slice(typecheck, secrets)).toContain("bunx tsc --noEmit");
    expect(typecheck).toBeLessThan(secrets);
    expect(secrets).toBeLessThan(deploy);
    expect(dockerfile).toContain("ARG POSTIL_DEPLOY_SOURCE_TYPECHECKED=0");
    expect(dockerfile).toContain(
      "POSTIL_DEPLOY_SOURCE_TYPECHECKED=${POSTIL_DEPLOY_SOURCE_TYPECHECKED}",
    );
    expect(deployWorkflow).toContain(
      "--build-arg POSTIL_DEPLOY_SOURCE_TYPECHECKED=1",
    );
    expect(nextConfig).toContain(
      'ignoreBuildErrors: process.env.POSTIL_DEPLOY_SOURCE_TYPECHECKED === "1"',
    );
  });
});

function managedMachine(
  group: "web" | "worker" | "monitor",
  hostedInferenceMode?: string,
  provisionalRosterMode?: string,
  state = "started",
  image = "registry.fly.io/postil-web:verified",
  mounts = group === "monitor"
    ? [{ volume: "vol_monitor", path: "/var/lib/postil-monitor" }]
    : [],
) {
  return {
    state,
    config: {
      image,
      metadata: {
        fly_platform_version: "v2",
        fly_process_group: group,
      },
      env: {
        ...(hostedInferenceMode === undefined
          ? {}
          : { POSTIL_HOSTED_INFERENCE_ENABLED: hostedInferenceMode }),
        ...(provisionalRosterMode === undefined
          ? {}
          : { POSTIL_PROVISIONAL_HOSTED_ROSTER: provisionalRosterMode }),
      },
      mounts,
    },
  };
}

function verifyManagedFleet(root: string, machines: unknown[]) {
  return Bun.spawnSync({
    cmd: ["jq", "-ce", "-f", join(root, "scripts/verify-managed-fleet.jq")],
    stdin: new Blob([JSON.stringify(machines)]),
    stderr: "pipe",
    stdout: "pipe",
  });
}

describe("web startup environment validation", () => {
  test("requires the private monitor database, origin, and operator recipient", () => {
    configureRequiredWebEnvironment();
    mutableEnv.NODE_ENV = "production";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.com";
    process.env.BREVO_API_KEY = "brevo-test-key";
    process.env.WORKER_HEARTBEAT_INTERVAL_MS = "30000";
    process.env.POSTIL_MONITOR_ALERT_STATE_PATH =
      "/var/lib/postil-monitor/alert-state.json";
    process.env.OPENROUTER_MANAGEMENT_API_KEY = "management-test-key";
    process.env.POSTIL_OPENROUTER_DEVELOPMENT_KEY_NAME = "development-test-key";
    process.env.POSTIL_OPENROUTER_PRODUCTION_KEY_NAME = "production-test-key";
    process.env.POSTIL_OPENROUTER_EMERGENCY_KEY_NAME = "emergency-test-key";

    expect(() => validateEnv("monitor")).not.toThrow();
    delete process.env.BREVO_API_KEY;
    expect(() => validateEnv("monitor")).toThrow(/BREVO_API_KEY/);
    process.env.BREVO_API_KEY = "brevo-test-key";
    delete process.env.POSTIL_OPERATOR_ALERT_EMAIL;
    expect(() => validateEnv("monitor")).toThrow(/POSTIL_OPERATOR_ALERT_EMAIL/);
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.com";
    delete process.env.DATABASE_URL;
    expect(() => validateEnv("monitor")).toThrow(/DATABASE_URL/);
    process.env.DATABASE_URL = "postgres://postil:postil@localhost:5432/postil";
    delete process.env.WORKER_HEARTBEAT_INTERVAL_MS;
    expect(() => validateEnv("monitor")).toThrow(/WORKER_HEARTBEAT_INTERVAL_MS/);
    process.env.WORKER_HEARTBEAT_INTERVAL_MS = "30000";
    delete process.env.OPENROUTER_MANAGEMENT_API_KEY;
    delete process.env.POSTIL_OPENROUTER_DEVELOPMENT_KEY_NAME;
    delete process.env.POSTIL_OPENROUTER_PRODUCTION_KEY_NAME;
    delete process.env.POSTIL_OPENROUTER_EMERGENCY_KEY_NAME;
    expect(() => validateEnv("monitor")).not.toThrow();
    process.env.OPENROUTER_MANAGEMENT_API_KEY = "management-test-key";
    delete process.env.POSTIL_MONITOR_ALERT_STATE_PATH;
    expect(() => validateEnv("monitor")).toThrow(
      /POSTIL_MONITOR_ALERT_STATE_PATH/,
    );
  });

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

  test("requires complete operator alert email configuration", () => {
    configureRequiredWebEnvironment();
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.com";
    delete process.env.BREVO_API_KEY;
    expect(() => validateEnv("web")).toThrow(/requires BREVO_API_KEY/);

    process.env.BREVO_API_KEY = "brevo-test-key";
    delete process.env.POSTIL_PUBLIC_URL;
    expect(() => validateEnv("web")).toThrow(/requires POSTIL_PUBLIC_URL/);

    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    expect(() => validateEnv("web")).not.toThrow();

    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "invalid";
    expect(() => validateEnv("web")).toThrow(/must be a valid email address/);
  });

  test("accepts only a strong optional iLert webhook password", () => {
    configureRequiredWebEnvironment();
    delete process.env.POSTIL_ILERT_WEBHOOK_SECRET;
    expect(() => validateEnv("web")).not.toThrow();

    process.env.POSTIL_ILERT_WEBHOOK_SECRET = "short";
    expect(() => validateEnv("web")).toThrow(/32 to 512 random printable ASCII bytes/);

    process.env.POSTIL_ILERT_WEBHOOK_SECRET = "0123456789abcdef".repeat(2);
    expect(() => validateEnv("web")).not.toThrow();

    process.env.POSTIL_ILERT_WEBHOOK_SECRET = "a".repeat(513);
    expect(() => validateEnv("web")).toThrow(/32 to 512 random printable ASCII bytes/);
  });

  test("validates operator alert dashboard links in the worker", () => {
    configureRequiredWorkerEnvironment();
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.com";
    process.env.BREVO_API_KEY = "brevo-test-key";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev/tenant";

    expect(() => validateEnv("worker")).toThrow(
      /invalid POSTIL_PUBLIC_URL.*without a path, query, or fragment/,
    );

    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    expect(() => validateEnv("worker")).not.toThrow();
  });

  test("keeps Paddle billing inert unless explicitly and completely enabled", () => {
    configureRequiredWebEnvironment();
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.PADDLE_API_KEY = "pdl_test";
    expect(() => validateEnv("web")).not.toThrow();

    process.env.POSTIL_PADDLE_BILLING_ENABLED = "yes";
    expect(() => validateEnv("web")).toThrow(/must be 0 or 1/);

    process.env.POSTIL_PADDLE_BILLING_ENABLED = "1";
    expect(() => validateEnv("web")).toThrow(/partially configured/);

    process.env.PADDLE_WEBHOOK_SECRET = "pdl_webhook_test";
    process.env.PADDLE_CLIENT_TOKEN = "test_client_token";
    process.env.PADDLE_ZERO_BASE_PRICE_ID = `pri_${"a".repeat(26)}`;
    process.env.PADDLE_ENVIRONMENT = "sandbox";
    expect(() => validateEnv("web")).not.toThrow();
  });

  test("rejects sandbox Paddle credentials in the production service", () => {
    configureRequiredWebEnvironment();
    mutableEnv.NODE_ENV = "production";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTIL_PADDLE_BILLING_ENABLED = "1";
    process.env.PADDLE_API_KEY = "pdl_test";
    process.env.PADDLE_WEBHOOK_SECRET = "pdl_webhook_test";
    process.env.PADDLE_CLIENT_TOKEN = "test_client_token";
    process.env.PADDLE_ZERO_BASE_PRICE_ID = `pri_${"a".repeat(26)}`;
    process.env.PADDLE_ENVIRONMENT = "sandbox";

    expect(() => validateEnv("web")).toThrow(
      /production requires PADDLE_ENVIRONMENT=production/,
    );
    process.env.PADDLE_ENVIRONMENT = "production";
    expect(() => validateEnv("web")).not.toThrow();
  });

  test("requires the settlement price in a Paddle-enabled worker", () => {
    configureRequiredWorkerEnvironment();
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTIL_PADDLE_BILLING_ENABLED = "1";
    process.env.PADDLE_API_KEY = "pdl_test";
    process.env.PADDLE_ENVIRONMENT = "production";
    expect(() => validateEnv("worker")).toThrow(
      /PADDLE_ACTIVE_AUTHOR_PRICE_ID/,
    );

    process.env.PADDLE_ACTIVE_AUTHOR_PRICE_ID = `pri_${"b".repeat(26)}`;
    expect(() => validateEnv("worker")).not.toThrow();
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
