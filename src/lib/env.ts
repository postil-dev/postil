/**
 * Startup configuration validation.
 *
 * Both the web process and the worker call validateEnv() at boot and fail
 * fast with an actionable message listing every missing variable, what it
 * is for, and an example value. Silent fallback to a broken default is the
 * documented anti-goal here.
 */

interface EnvVarSpec {
  name: string;
  purpose: string;
  example: string;
  /** Required for which processes. */
  scope: Array<"web" | "worker">;
  optional?: boolean;
}

const ENV_SPECS: EnvVarSpec[] = [
  {
    name: "DATABASE_URL",
    purpose: "Postgres connection string used by web and worker",
    example: "postgres://postil:postil@localhost:5432/postil",
    scope: ["web", "worker"],
  },
  {
    name: "POSTIL_DB_POOL_MAX",
    purpose: "Maximum Postgres connections per process; keep low for free-tier hosted Postgres",
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
    purpose: "Shared secret for verifying X-Hub-Signature-256 on GitHub webhooks",
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
    purpose: "AES-256-GCM key (32 bytes, hex or base64) sealing org BYOK credentials",
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
    name: "POSTIL_ENDPOINT_AUTH_HEADER",
    purpose: "Optional additional authentication header for a private provider gateway",
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
    example: "deepseek/deepseek-v4-pro",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "REVIEW_MODEL_CASCADE",
    purpose: "Comma-separated fallback models",
    example: "qwen/qwen3-coder",
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
    purpose: "Brevo transactional email API key for human-escalation notifications",
    example: "xkeysib-...",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_ESCALATION_FROM_EMAIL",
    purpose: "Verified Brevo sender address for human-escalation notifications",
    example: "reviews@mail.postil.dev",
    scope: ["web", "worker"],
    optional: true,
  },
  {
    name: "POSTIL_ESCALATION_FROM_NAME",
    purpose: "Sender display name for human-escalation notifications",
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
    purpose: "Maximum jobs a webhook-triggered web drain processes before yielding",
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
      "PostHog project token for server-side request telemetry; same value as NEXT_PUBLIC_POSTHOG_KEY",
    example: "phc_...",
    scope: ["web"],
    optional: true,
  },
  {
    name: "NEXT_PUBLIC_POSTHOG_KEY",
    purpose: "PostHog project token compiled into the browser analytics bundle",
    example: "phc_...",
    scope: ["web"],
    optional: true,
  },
  {
    name: "NEXT_PUBLIC_POSTHOG_HOST",
    purpose: "PostHog ingestion host matching the project region",
    example: "https://eu.i.posthog.com",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTHOG_SERVER_CAPTURE",
    purpose: "Set to 0 to disable server-side request telemetry while keeping browser analytics",
    example: "1",
    scope: ["web"],
    optional: true,
  },
  {
    name: "POSTHOG_CLIENT_CAPTURE",
    purpose:
      "Set to 0 to disable client-side browser analytics (no PostHog init, no analytics cookies) while keeping server-side request telemetry",
    example: "1",
    scope: ["web"],
    optional: true,
  },
];

export function validateEnv(processKind: "web" | "worker"): void {
  const missing: EnvVarSpec[] = [];
  for (const spec of ENV_SPECS) {
    if (!spec.scope.includes(processKind) || spec.optional) continue;
    const value = process.env[spec.name];
    if (!value || value.trim() === "") missing.push(spec);
  }
  if (processKind === "web" && process.env.POSTIL_WEBHOOK_DRAIN_ENABLED === "1") {
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "POSTIL_BIN"]) {
      const spec = ENV_SPECS.find((s) => s.name === name);
      const value = process.env[name];
      if (spec && (!value || value.trim() === "")) missing.push(spec);
    }
  }
  if (missing.length > 0) {
    const lines = missing.map(
      (s) => `  ${s.name}\n    purpose: ${s.purpose}\n    example: ${s.example}`,
    );
    throw new Error(
      `Postil ${processKind} cannot start: ${missing.length} required environment variable(s) missing.\n` +
        `${lines.join("\n")}\n` +
        `Copy .env.example to .env and fill these in. See /docs/self-hosted for details.`,
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

export function optionalEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value && value.trim() !== "") return value;
  return fallback;
}
