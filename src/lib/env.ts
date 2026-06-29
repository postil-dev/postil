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
    purpose: "AES-256-GCM key (32 bytes, hex or base64) sealing org BYO API keys",
    example: "openssl rand -hex 32",
    scope: ["web", "worker"],
  },
  {
    name: "POSTIL_API_KEY",
    purpose:
      "Default LLM API key for hosted reviews when an org has no BYO key (falls back to OPENROUTER_API_KEY)",
    example: "sk-or-v1-...",
    scope: ["worker"],
    optional: true,
  },
  {
    name: "POSTIL_API_BASE",
    purpose: "OpenAI-compatible API base URL",
    example: "https://openrouter.ai/api/v1",
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
    name: "POSTIL_BIN",
    purpose: "Path to the postil CLI binary the worker spawns",
    example: "/usr/local/bin/postil",
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
];

export function validateEnv(processKind: "web" | "worker"): void {
  const missing: EnvVarSpec[] = [];
  for (const spec of ENV_SPECS) {
    if (!spec.scope.includes(processKind) || spec.optional) continue;
    const value = process.env[spec.name];
    if (!value || value.trim() === "") missing.push(spec);
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
