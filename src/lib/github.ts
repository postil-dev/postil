import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { env } from "@/lib/env";

const PostilOctokit = Octokit.plugin(throttling, retry);

type ThrottleOpts = {
  method: string;
  url: string;
};

function throttleHandlers() {
  return {
    onRateLimit: (retryAfter: number, options: ThrottleOpts, _octokit: unknown, retryCount: number) => {
      if (retryCount < 2) return true;
      console.warn(`[github] rate limit on ${options.method} ${options.url}, retryAfter=${retryAfter}s`);
      return false;
    },
    onSecondaryRateLimit: (_retryAfter: number, options: ThrottleOpts) => {
      console.warn(`[github] secondary rate limit on ${options.method} ${options.url}`);
      return true;
    },
  };
}

export function appOctokit(): Octokit {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
  }
  return new PostilOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    },
    throttle: throttleHandlers(),
  });
}

export async function installationOctokit(installationId: number): Promise<Octokit> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
  }
  return new PostilOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
      installationId,
    },
    throttle: throttleHandlers(),
  });
}

export async function mintInstallationToken(installationId: number): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
  }
  const auth = createAppAuth({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
  const { token } = await auth({ type: "installation", installationId });
  return token;
}
