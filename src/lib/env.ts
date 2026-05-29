import { z } from "zod";

/**
 * Zod-validated environment. Pulls from process.env, which in local dev is
 * populated from .env.local. Env var names match deployed service
 * services where possible (NEON_CONNECTION_STRING, FLY_ORG_TOKEN, etc).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

  // Database: prefer NEON_CONNECTION_STRING, fall back to DATABASE_URL for
  // self-host users who aren't on Neon.
  DATABASE_URL: z.string().optional(),
  NEON_CONNECTION_STRING: z.string().optional(),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  NEON_PERSONAL_API_KEY: z.string().optional(),

  // GitHub App
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_B64: z.string().optional(),
  GITHUB_APP_SLUG: z.string().default("postil"),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  CI_RECOVERY_FALLBACK_ASSIGNEE: z.string().optional(),
  // Personal access token (bootstrap / CI), not for runtime request auth.
  GITHUB_PAT: z.string().optional(),

  // Polar (billing). Live checkout blocked until KYC approval; sandbox works.
  POLAR_API_KEY: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),
  POLAR_ORG_ID: z.string().optional(),
  POLAR_ORG_SLUG: z.string().optional(),
  POLAR_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),

  // Trigger.dev
  TRIGGER_API_KEY: z.string().optional(),
  TRIGGER_SECRET_KEY: z.string().optional(),
  TRIGGER_API_TOKEN: z.string().optional(),
  TRIGGER_PROJECT_ID: z.string().optional(),
  TRIGGER_API_URL: z.string().url().default("https://api.trigger.dev"),

  // Fly
  FLY_ORG_TOKEN: z.string().optional(),
  FLY_ORG_SLUG: z.string().default("personal"),
  FLY_SANDBOX_APP: z.string().optional(),

  // PostHog (EU)
  POSTHOG_PROJECT_TOKEN: z.string().optional(),
  POSTHOG_HOST: z.string().url().default("https://eu.i.posthog.com"),
  POSTHOG_REGION: z.string().default("eu"),
  POSTHOG_PROJECT_ID: z.string().optional(),
  POSTHOG_PERSONAL_API_KEY: z.string().optional(),

  // PostHog client-side (marketing site)
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default("https://eu.i.posthog.com"),

  // OpenRouter (AI provider for the review bot). Management key is used to
  // vend per-workspace keys.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MANAGEMENT_KEY: z.string().optional(),
  REVIEW_MODEL: z.string().default("moonshotai/kimi-k2.6"),
  REVIEW_MODEL_CASCADE: z.string().optional(),
  POSTIL_CLI_PATH: z.string().optional(),

  // Cloudflare
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),

  // Sandbox driver selection
  SANDBOX_DRIVER: z.enum(["fly", "e2b", "docker"]).default("fly"),

  // Operator metrics endpoint auth
  METRICS_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

const parsed = schema.parse(process.env);

export const env: Env & {
  /** Unified database URL: `NEON_CONNECTION_STRING` takes precedence. */
  databaseUrl: string | undefined;
  /** Unified Trigger auth token: supports old and current deployed names. */
  triggerApiKey: string | undefined;
} = {
  ...parsed,
  databaseUrl: parsed.NEON_CONNECTION_STRING ?? parsed.DATABASE_URL,
  triggerApiKey: parsed.TRIGGER_SECRET_KEY ?? parsed.TRIGGER_API_KEY ?? parsed.TRIGGER_API_TOKEN,
};
