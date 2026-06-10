/**
 * Runtime env access. Centralised so we never sprinkle `process.env.X` checks
 * across the codebase, and so the missing-required-secret error message is
 * always consistent.
 *
 * SAFETY: no secret values are ever logged. We only ever report whether a key
 * was missing or empty.
 */

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  // Database.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // GitHub App.
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_INSTALL_URL: z.string().url().optional(),

  // Auth (Better Auth).
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),

  // OpenRouter — backend NEVER calls this directly; surfaced here only as a
  // sanity-check value to inject into the worker when running locally.
  OPENROUTER_API_KEY: z.string().optional(),

  // Hosted worker.
  POSTIL_CLI_PATH: z.string().default("postil"),
  WORKER_TOKEN: z.string().optional(),
  REVIEW_TOKEN_SECRET: z.string().optional(),

  // Operator endpoints.
  METRICS_API_KEY: z.string().optional(),

  // Polar (billing).
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),

  // PostHog (EU).
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().default("https://eu.posthog.com"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when this build is allowed to dispatch to GitHub (full app credentials present). */
export function hasGithubApp(): boolean {
  const e = env();
  return Boolean(
    e.GITHUB_APP_ID &&
      e.GITHUB_APP_PRIVATE_KEY &&
      e.GITHUB_APP_CLIENT_ID &&
      e.GITHUB_APP_CLIENT_SECRET &&
      e.GITHUB_WEBHOOK_SECRET,
  );
}
