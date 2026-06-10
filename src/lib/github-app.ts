/**
 * GitHub App helpers. Issues installation tokens that the worker uses to
 * authenticate against the GitHub API.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import { env } from "./env";

let cachedAppOctokit: Octokit | null = null;

function appAuth() {
  const e = env();
  if (!e.GITHUB_APP_ID || !e.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App is not configured");
  }
  return createAppAuth({
    appId: e.GITHUB_APP_ID,
    privateKey: e.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
}

export function appOctokit(): Octokit {
  if (cachedAppOctokit) return cachedAppOctokit;
  cachedAppOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env().GITHUB_APP_ID,
      privateKey: env().GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
  });
  return cachedAppOctokit;
}

export async function mintInstallationToken(installationId: number): Promise<{
  token: string;
  expiresAt: string;
}> {
  const auth = appAuth();
  const result = await auth({ type: "installation", installationId });
  return { token: result.token, expiresAt: result.expiresAt };
}

export async function createCheckRun(
  installationId: number,
  repoFullName: string,
  headSha: string,
  checkName: string,
): Promise<number> {
  const auth = appAuth();
  const { token } = await auth({ type: "installation", installationId });
  const octo = new Octokit({ auth: token });
  const [owner, repo] = repoFullName.split("/", 2);
  if (!owner || !repo) throw new Error(`bad repo full name: ${repoFullName}`);
  const resp = await octo.checks.create({
    owner,
    repo,
    name: checkName,
    head_sha: headSha,
    status: "in_progress",
  });
  return resp.data.id;
}
