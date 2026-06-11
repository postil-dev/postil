import { checkout, polar, portal } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { env } from "@/lib/env";

// TODO(postil): replace in-memory adapter with a Drizzle adapter wiring
// Better Auth's user/session/account tables to our Postgres instance.
// Tracking: https://www.better-auth.com/docs/adapters/drizzle
const polarClient = env.POLAR_API_KEY
  ? new Polar({
      accessToken: env.POLAR_API_KEY,
      server: env.POLAR_ENVIRONMENT,
    })
  : undefined;

function authSecret(): string {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET must be set in production.");
  }
  return randomUUID();
}

export function assertAuthSecretConfigured(): void {
  if (env.NODE_ENV === "production" && !env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET must be set in production.");
  }
}

function createAuth() {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: authSecret(),
    socialProviders: env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_APP_CLIENT_ID,
            clientSecret: env.GITHUB_APP_CLIENT_SECRET,
          },
        }
      : {},
    plugins: [
      organization(),
      ...(polarClient
        ? [
            polar({
              client: polarClient,
              createCustomerOnSignUp: true,
              use: [checkout({ authenticatedUsersOnly: true }), portal()],
            }),
          ]
        : []),
    ],
  });
}

export const getAuth = cache(createAuth);
