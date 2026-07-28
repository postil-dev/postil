/**
 * Public GitHub App install URL. The slug is configurable so a future app
 * rename does not require a code change; the default is the app the hosted
 * control plane runs as (client id Iv23lisiHwVB3E4A27UF).
 */
export function githubAppSlug(): string {
  return process.env.GITHUB_APP_SLUG?.trim() || "postil-dev";
}

export function githubAppInstallUrl(): string {
  return `https://github.com/apps/${githubAppSlug()}/installations/new`;
}

/** Login GitHub assigns to comments created by this App installation. */
export function githubAppBotLogin(): string {
  return `${githubAppSlug()}[bot]`;
}

interface GithubInstallationRef {
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
}

/** GitHub's settings page for one existing account-scoped installation. */
export function githubInstallationSettingsUrl(
  installation: GithubInstallationRef,
): string {
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.githubInstallationId}`
    : `https://github.com/settings/installations/${installation.githubInstallationId}`;
}
