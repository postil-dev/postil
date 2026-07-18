/**
 * Startup configuration validation.
 *
 * Both the web process and the worker call validateEnv() at boot and fail
 * fast with an actionable message listing every missing variable, what it
 * is for, and an example value. Silent fallback to a broken default is the
 * documented anti-goal here.
 */

import { configuredPublicOrigin } from "@/lib/oauth";

interface EnvVarSpec {
  name: string;
  purpose: string;
  example: string;
  /** Required for which processes. */
  scope: Array<"web" | "worker">;
  optional?: boolean;
  /** Required only when NODE_ENV is production. */
  productionOnly?: boolean;
}

const ENV_SPECS: EnvVarSpec[] = [
  {
    name: "DATABASE_URL",
    purpose: "Postgres connection string used by web and worker",
    example: "postgres://postil:postil@localhost:5432/postil",
    scope: ["web", "worker"],
  },
  {
    name: "POSTIL_PUBLIC_URL",
    purpose:
      "Canonical HTTPS origin used for browser URLs and proxy-safe request telemetry",
    example: "https://postil.example.com",
    scope: ["web"],
    productionOnly: true,
  },
  {
    name: "POSTIL_DB_POOL_MAX",
    purpose:
      "Maximum Postgres connections per process; keep low for free-tier hosted Postgres",
    example: "2",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_SESSION_SECRET",
    purpose: "HMAC key for signing session cookies (32+ random bytes)",
    example: "openssl rand -hex 32",
    scope: ["web"],
  },
  {
    name: "GITHUB_WEBHOOK_SECRET",
    purpose:
      "Shared secret for verifying X-Hub-Signature-256 on GitHub webhooks",
    example: "openssl rand -hex 32",
    scope: ["web"],
  },
  {
    name: "GITHUB_OAUTH_CLIENT_ID",
    purpose: "OAuth app client id for dashboard login",
    example: "Iv1.0123456789abcdef",
    scope: ["web"],
  },
  {
    name: "GITHUB_OAUTH_CLIENT_SECRET",
    purpose: "OAuth app client secret for dashboard login",
    example: "from the GitHub OAuth app settings page",
    scope: ["web"],
  },
  {
    name: "GITHUB_APP_ID",
    purpose: "GitHub App id used to mint installation tokens",
    example: "123456",
    scope: ["worker"],
  },
  {
    name: "GITHUB_APP_PRIVATE_KEY",
    purpose: "GitHub App private key, PEM or base64-encoded PEM",
    example: "-----BEGIN RSA PRIVATE KEY----- ... (or its base64)",
    scope: ["worker"],
  },
  {
    name: "POSTIL_SEALING_KEY",
    purpose:
      "AES-256-GCM key (32 bytes, hex or base64) sealing OAuth sessions and org BYOK credentials",
    example: "openssl rand -hex 32",
    scope: ["web", "worker"],
  },
  {
    name: "MODEL_API_KEY",
    purpose:
      "Default model provider API key for hosted reviews when an org has no BYOK credential",
    example: "sk-or-v1-...",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_API_KEY",
    purpose:
      "Legacy model provider API key alias; MODEL_API_KEY is preferred and OPENROUTER_API_KEY remains accepted",
    example: "sk-or-v1-...",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_API_BASE",
    purpose: "Hosted model provider API base URL",
    example: "https://openrouter.ai/api/v1",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_API_FORMAT",
    purpose: "Hosted provider interface: openai-compatible or anthropic",
    example: "openai-compatible",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_ALLOW_PRIVATE_API_BASE",
    purpose:
      "Explicit opt-in for a self-hosted model endpoint on a private network",
    example: "1",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_ENDPOINT_AUTH_HEADER",
    purpose:
      "Optional additional authentication header for a private provider gateway",
    example: "CF-Access-Client-Secret",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_ENDPOINT_AUTH_VALUE",
    purpose: "Value paired with POSTIL_ENDPOINT_AUTH_HEADER",
    example: "provider gateway credential",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "REVIEW_MODEL",
    purpose: "Default review model",
    example: "z-ai/glm-5.2",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_HOSTED_INFERENCE_ENABLED",
    purpose:
      "Set to 0 to pause the built-in hosted provider while keeping organization BYOK providers available",
    example: "1",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "REVIEW_MODEL_CASCADE",
    purpose: "Comma-separated fallback models",
    example: "moonshotai/kimi-k2.7-code,deepseek/deepseek-v4-flash",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_LLM_REQUEST_TIMEOUT_SECS",
    purpose:
      "Maximum seconds for one spawned CLI model-provider request; worker defaults below its review watchdog",
    example: "420",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_LLM_TOTAL_TIMEOUT_SECS",
    purpose:
      "Maximum seconds for all spawned CLI model-provider requests in one review; worker defaults below its review watchdog",
    example: "540",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "BREVO_API_KEY",
    purpose: "Brevo transactional email API key",
    example: "xkeysib-...",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_EMAIL_FROM_EMAIL",
    purpose: "Verified Brevo sender address for transactional email",
    example: "reviews@mail.postil.dev",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_EMAIL_FROM_NAME",
    purpose: "Sender display name for transactional email",
    example: "Postil",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_OPERATOR_ALERT_EMAIL",
    purpose: "Verified operator inbox for one-time trial signup alerts",
    example: "ops@example.com",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_PADDLE_BILLING_ENABLED",
    purpose:
      "Explicitly enable self-service Paddle checkout, webhooks, and settlement",
    example: "0",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "PADDLE_API_KEY",
    purpose:
      "Paddle Billing API key for checkout creation and active-author settlement",
    example: "from Paddle > Developer tools > Authentication",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "PADDLE_WEBHOOK_SECRET",
    purpose: "Paddle notification destination secret for webhook verification",
    example: "from Paddle > Developer tools > Notifications",
    scope: ["web"],
    optional: true,
  },
  {
    name: "PADDLE_CLIENT_TOKEN",
    purpose:
      "Public Paddle.js client token returned only to authenticated billing admins",
    example: "test_... or live_...",
    scope: ["web"],
    optional: true,
  },
  {
    name: "PADDLE_ZERO_BASE_PRICE_ID",
    purpose:
      "Zero-dollar monthly recurring price used to retain the payment method",
    example: "pri_01...",
    scope: ["web"],
    optional: true,
  },
  {
    name: "PADDLE_ACTIVE_AUTHOR_PRICE_ID",
    purpose:
      "Six-dollar one-time price charged once per active private-PR author period",
    example: "pri_01...",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "PADDLE_ENVIRONMENT",
    purpose: "Paddle API and checkout environment",
    example: "sandbox",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_ESCALATION_FROM_EMAIL",
    purpose: "Legacy alias for POSTIL_EMAIL_FROM_EMAIL",
    example: "reviews@mail.postil.dev",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_ESCALATION_FROM_NAME",
    purpose: "Legacy alias for POSTIL_EMAIL_FROM_NAME",
    example: "Postil",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_BIN",
    purpose: "Path to the postil CLI binary the worker or webhook drain spawns",
    example: "/usr/local/bin/postil",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_WEBHOOK_DRAIN_ENABLED",
    purpose:
      "When set to 1, the web process drains a small number of queued jobs immediately after webhook enqueue",
    example: "1",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTIL_QUEUE_DRAIN_MAX_JOBS",
    purpose:
      "Maximum jobs a webhook-triggered web drain processes before yielding",
    example: "1",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTIL_QUEUE_DRAIN_DEADLINE_MS",
    purpose: "Wall-clock budget for one webhook-triggered queue drain",
    example: "720000",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTIL_RESPOND_HOURLY_CAP",
    purpose:
      "Maximum @postil respond jobs enqueued per installation per rolling hour before further mentions are skipped",
    example: "30",
    scope: ["web"],
    optional: true,
  },
  {
    name: "WORKER_POLL_INTERVAL_MS",
    purpose: "Initial worker queue poll interval",
    example: "1000",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "WORKER_IDLE_POLL_MAX_MS",
    purpose:
      "Maximum idle worker queue poll interval; raise this for serverless Postgres free-tier scale-to-zero",
    example: "900000",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "WORKER_WATCHDOG_INTERVAL_MS",
    purpose:
      "Worker watchdog interval; raise this with idle polling for serverless Postgres free-tier scale-to-zero",
    example: "900000",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "WORKER_WEBHOOK_REDELIVERY_INTERVAL_MS",
    purpose:
      "Interval between bounded GitHub App failed-delivery recovery passes",
    example: "300000",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "METRICS_TOKEN",
    purpose: "Bearer token protecting /api/metrics",
    example: "openssl rand -hex 24",
    scope: ["web"],
    optional: true,
  },
  {
    name: "METRICS_API_KEY",
    purpose: "Legacy bearer token name accepted for /api/metrics",
    example: "openssl rand -hex 24",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTIL_OPERATOR_GITHUB_IDS",
    purpose:
      "Comma-separated GitHub numeric user ids allowed to open the cross-organization operator dashboard",
    example: "1234567,2345678",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTHOG_PROJECT_TOKEN",
    purpose:
      "PostHog project token for privacy-scoped analytics and optional operational telemetry",
    example: "phc_...",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "NEXT_PUBLIC_POSTHOG_KEY",
    purpose:
      "Legacy runtime alias for POSTHOG_PROJECT_TOKEN; no value is compiled into the browser bundle",
    example: "phc_...",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "NEXT_PUBLIC_POSTHOG_HOST",
    purpose: "PostHog ingestion host matching the project region",
    example: "https://eu.i.posthog.com",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTHOG_SERVER_CAPTURE",
    purpose:
      "Set to 0 to disable server-side request telemetry while keeping browser analytics",
    example: "1",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTHOG_CLIENT_CAPTURE",
    purpose:
      "Set to 0 to disable cookieless public-page browser analytics while keeping server-side request telemetry",
    example: "1",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTHOG_ERROR_CAPTURE",
    purpose:
      "Set to 1 to send scrubbed operational exceptions to PostHog Error Tracking",
    example: "0",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTHOG_LOG_CAPTURE",
    purpose:
      "Set to 1 to export allowlisted operational events to PostHog Logs over OTLP",
    example: "0",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTHOG_LOG_WARN_SAMPLE_RATE",
    purpose: "Deterministic sampling rate for warning-level operational logs",
    example: "0.1",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTHOG_LOG_INFO_SAMPLE_RATE",
    purpose: "Deterministic sampling rate for informational operational logs",
    example: "0.01",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTHOG_LOG_MAX_PER_MINUTE",
    purpose: "Hard per-process cap on exported operational log records",
    example: "60",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTHOG_ERROR_MAX_PER_HOUR",
    purpose: "Hard per-process cap on exported operational exceptions",
    example: "10",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_RELEASE_SHA",
    purpose: "Git commit SHA attached to operational telemetry",
    example: "0123456789abcdef0123456789abcdef01234567",
    scope: ["web", "worker"],
    optional: true,
  },
];

export function validateEnv(processKind: "web" | "worker"): void {
  const missing: EnvVarSpec[] = [];
  for (const spec of ENV_SPECS) {
    if (!spec.scope.includes(processKind) || spec.optional) continue;
    if (spec.productionOnly && process.env.NODE_ENV !== "production") continue;
    const value = process.env[spec.name];
    if (!value || value.trim() === "") missing.push(spec);
  }
  if (
    processKind === "web" &&
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED === "1"
  ) {
    for (const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "POSTIL_BIN",
    ]) {
      const spec = ENV_SPECS.find((s) => s.name === name);
      const value = process.env[name];
      if (spec && (!value || value.trim() === "")) missing.push(spec);
    }
  }
  if (missing.length > 0) {
    const lines = missing.map(
      (s) =>
        `  ${s.name}\n    purpose: ${s.purpose}\n    example: ${s.example}`,
    );
    throw new Error(
      `Postil ${processKind} cannot start: ${missing.length} required environment variable(s) missing.\n` +
        `${lines.join("\n")}\n` +
        `Copy .env.example to .env and fill these in. See /docs/self-hosted for details.`,
    );
  }
  if (processKind === "web" && process.env.POSTIL_PUBLIC_URL?.trim()) {
    validateConfiguredPublicOrigin(processKind);
  }
  if (
    processKind === "worker" &&
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED !== undefined &&
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED !== "0" &&
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED !== "1"
  ) {
    throw new Error(
      "Postil worker cannot start: POSTIL_HOSTED_INFERENCE_ENABLED must be 0 or 1.",
    );
  }
  validateOperationalTelemetryEnv(processKind);
  validateOperatorAlertEnv(processKind);
  validatePaddleEnv(processKind);
}

function validatePaddleEnv(processKind: "web" | "worker"): void {
  const enabled = process.env.POSTIL_PADDLE_BILLING_ENABLED;
  if (enabled !== undefined && enabled !== "0" && enabled !== "1") {
    throw new Error(
      `Postil ${processKind} cannot start: POSTIL_PADDLE_BILLING_ENABLED must be 0 or 1.`,
    );
  }
  if (enabled !== "1") return;

  const required =
    processKind === "web"
      ? [
          "PADDLE_API_KEY",
          "PADDLE_WEBHOOK_SECRET",
          "PADDLE_CLIENT_TOKEN",
          "PADDLE_ZERO_BASE_PRICE_ID",
          "PADDLE_ENVIRONMENT",
        ]
      : [
          "PADDLE_API_KEY",
          "PADDLE_ACTIVE_AUTHOR_PRICE_ID",
          "PADDLE_ENVIRONMENT",
        ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Postil ${processKind} cannot start: Paddle Billing is partially configured; missing ${missing.join(", ")}.`,
    );
  }
  if (!process.env.POSTIL_PUBLIC_URL?.trim()) {
    throw new Error(
      `Postil ${processKind} cannot start: Paddle Billing requires POSTIL_PUBLIC_URL.`,
    );
  }
  const environment = process.env.PADDLE_ENVIRONMENT;
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(
      `Postil ${processKind} cannot start: PADDLE_ENVIRONMENT must be sandbox or production.`,
    );
  }
  if (process.env.NODE_ENV === "production" && environment !== "production") {
    throw new Error(
      `Postil ${processKind} cannot start: production requires PADDLE_ENVIRONMENT=production.`,
    );
  }
  for (const name of [
    "PADDLE_ZERO_BASE_PRICE_ID",
    "PADDLE_ACTIVE_AUTHOR_PRICE_ID",
  ] as const) {
    const value = process.env[name]?.trim();
    if (value && !/^pri_[a-z0-9]{26}$/.test(value)) {
      throw new Error(
        `Postil ${processKind} cannot start: ${name} must be a Paddle price ID.`,
      );
    }
  }
}

function validateOperatorAlertEnv(processKind: "web" | "worker"): void {
  const recipient = process.env.POSTIL_OPERATOR_ALERT_EMAIL?.trim();
  if (!recipient) return;
  if (recipient.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error(
      `Postil ${processKind} cannot start: POSTIL_OPERATOR_ALERT_EMAIL must be a valid email address.`,
    );
  }
  if (!process.env.BREVO_API_KEY?.trim()) {
    throw new Error(
      `Postil ${processKind} cannot start: POSTIL_OPERATOR_ALERT_EMAIL requires BREVO_API_KEY.`,
    );
  }
  if (!process.env.POSTIL_PUBLIC_URL?.trim()) {
    throw new Error(
      `Postil ${processKind} cannot start: POSTIL_OPERATOR_ALERT_EMAIL requires POSTIL_PUBLIC_URL.`,
    );
  }
  validateConfiguredPublicOrigin(processKind);
}

function validateConfiguredPublicOrigin(processKind: "web" | "worker"): void {
  try {
    configuredPublicOrigin();
  } catch (error) {
    const detail = safePublicUrlValidationDetail(error);
    throw new Error(
      `Postil ${processKind} cannot start: invalid POSTIL_PUBLIC_URL.${detail ? ` ${detail}` : ""}`,
    );
  }
}

function safePublicUrlValidationDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return /^POSTIL_PUBLIC_URL must (?:not contain credentials|be an origin without a path, query, or fragment|use https \(http is allowed only for local development\))$/.test(
    error.message,
  )
    ? error.message
    : undefined;
}

function validateOperationalTelemetryEnv(processKind: "web" | "worker"): void {
  for (const name of [
    "POSTHOG_ERROR_CAPTURE",
    "POSTHOG_LOG_CAPTURE",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined && value !== "0" && value !== "1") {
      throw new Error(
        `Postil ${processKind} cannot start: ${name} must be 0 or 1.`,
      );
    }
  }

  const enabled =
    process.env.POSTHOG_ERROR_CAPTURE === "1" ||
    process.env.POSTHOG_LOG_CAPTURE === "1";
  if (!enabled) return;

  const token =
    process.env.POSTHOG_PROJECT_TOKEN ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!token?.trim()) {
    throw new Error(
      `Postil ${processKind} cannot start: operational PostHog telemetry requires POSTHOG_PROJECT_TOKEN.`,
    );
  }

  const host =
    process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";
  let parsedHost: URL;
  try {
    parsedHost = new URL(host);
  } catch {
    throw new Error(
      `Postil ${processKind} cannot start: NEXT_PUBLIC_POSTHOG_HOST must be an HTTP(S) origin.`,
    );
  }
  if (
    !["http:", "https:"].includes(parsedHost.protocol) ||
    parsedHost.username ||
    parsedHost.password ||
    parsedHost.pathname !== "/" ||
    parsedHost.search ||
    parsedHost.hash ||
    (process.env.NODE_ENV === "production" && parsedHost.protocol !== "https:")
  ) {
    throw new Error(
      `Postil ${processKind} cannot start: NEXT_PUBLIC_POSTHOG_HOST must be a credential-free HTTPS origin in production.`,
    );
  }

  for (const name of [
    "POSTHOG_LOG_WARN_SAMPLE_RATE",
    "POSTHOG_LOG_INFO_SAMPLE_RATE",
  ] as const) {
    const value = process.env[name];
    if (value === undefined) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new Error(
        `Postil ${processKind} cannot start: ${name} must be between 0 and 1.`,
      );
    }
  }

  for (const name of [
    "POSTHOG_LOG_MAX_PER_MINUTE",
    "POSTHOG_ERROR_MAX_PER_HOUR",
  ] as const) {
    const value = process.env[name];
    if (value === undefined) continue;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(
        `Postil ${processKind} cannot start: ${name} must be a positive integer.`,
      );
    }
  }

  const release = process.env.POSTIL_RELEASE_SHA;
  if (release?.trim() && !/^[0-9a-f]{7,40}$/i.test(release)) {
    throw new Error(
      `Postil ${processKind} cannot start: POSTIL_RELEASE_SHA must be a 7-40 character hexadecimal commit SHA.`,
    );
  }
}

/** Read a required env var lazily, with an actionable error. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    const spec = ENV_SPECS.find((s) => s.name === name);
    const hint = spec ? ` (${spec.purpose}; example: ${spec.example})` : "";
    throw new Error(`Missing required environment variable ${name}${hint}`);
  }
  return value;
}

export function optionalEnv(
  name: string,
  fallback?: string,
): string | undefined {
  const value = process.env[name];
  if (value && value.trim() !== "") return value;
  return fallback;
}

/** The hosted service opts in explicitly; self-hosted installs retain existing behavior. */
export function hostedInferenceEnabled(): boolean {
  return optionalEnv("POSTIL_HOSTED_INFERENCE_ENABLED", "1") === "1";
}
