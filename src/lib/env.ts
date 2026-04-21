import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().optional(),
  DATABASE_URL_UNPOOLED: z.string().optional(),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),
  POLAR_ORGANIZATION_ID: z.string().optional(),
  POLAR_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),

  TRIGGER_API_KEY: z.string().optional(),
  TRIGGER_PROJECT_ID: z.string().optional(),
  TRIGGER_API_URL: z.string().url().default("https://api.trigger.dev"),

  FLY_API_TOKEN: z.string().optional(),
  FLY_ORG_SLUG: z.string().default("personal"),
  FLY_SANDBOX_APP: z.string().default("postil-sandbox"),

  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().default("https://eu.posthog.com"),
  POSTHOG_PROJECT_ID: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),

  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),

  SANDBOX_DRIVER: z.enum(["fly", "e2b", "docker"]).default("fly"),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
