import { checkout, polar, portal } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { env } from "@/lib/env";

// TODO(postil): replace in-memory adapter with a Drizzle adapter wiring
// Better Auth's user/session/account tables to our Postgres instance.
// Tracking: https://www.better-auth.com/docs/adapters/drizzle
const polarClient = env.POLAR_ACCESS_TOKEN
  ? new Polar({
      accessToken: env.POLAR_ACCESS_TOKEN,
      server: env.POLAR_ENVIRONMENT,
    })
  : undefined;

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-dev-secret-change-me",
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

export type Auth = typeof auth;
