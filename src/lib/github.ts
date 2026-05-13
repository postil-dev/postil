import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { env } from "@/lib/env";

const PostilOctokit = Octokit.plugin(throttling, retry);

type ThrottleOpts = { method: string; url: string };

function throttleHandlers() {
  return {
    onRateLimit: (
      retryAfter: number,
      options: ThrottleOpts,
      _octokit: unknown,
      retryCount: number,
    ) => {
      if (retryCount < 2) return true;
      console.warn(
        `[github] rate limit on ${options.method} ${options.url}, retryAfter=${retryAfter}s`,
      );
      return false;
    },
    onSecondaryRateLimit: (_retryAfter: number, options: ThrottleOpts) => {
      console.warn(`[github] secondary rate limit on ${options.method} ${options.url}`);
      return true;
    },
  };
}

/**
 * Resolve the App private key from either:
 * - `GITHUB_APP_PRIVATE_KEY_B64` (base64-encoded PEM), preferred — no `\n`
 *   escaping required and survives copy/paste round-trips,
 * - or `GITHUB_APP_PRIVATE_KEY` (raw PEM, optionally with literal `\n`).
 */
function resolvePrivateKey(): string {
  if (env.GITHUB_APP_PRIVATE_KEY_B64) {
    return Buffer.from(env.GITHUB_APP_PRIVATE_KEY_B64, "base64").toString("utf8");
  }
  if (env.GITHUB_APP_PRIVATE_KEY) {
    return env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  throw new Error("GITHUB_APP_PRIVATE_KEY_B64 or GITHUB_APP_PRIVATE_KEY must be set");
}

function requireAppId(): string {
  if (!env.GITHUB_APP_ID) throw new Error("GITHUB_APP_ID must be set");
  return env.GITHUB_APP_ID;
}

export function appOctokit(): Octokit {
  return new PostilOctokit({
    authStrategy: createAppAuth,
    auth: { appId: requireAppId(), privateKey: resolvePrivateKey() },
    throttle: throttleHandlers(),
  });
}

export async function installationOctokit(installationId: number): Promise<Octokit> {
  return new PostilOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: requireAppId(),
      privateKey: resolvePrivateKey(),
      installationId,
    },
    throttle: throttleHandlers(),
  });
}

export async function mintInstallationToken(installationId: number): Promise<string> {
  const auth = createAppAuth({
    appId: requireAppId(),
    privateKey: resolvePrivateKey(),
  });
  const { token } = await auth({ type: "installation", installationId });
  return token;
}
