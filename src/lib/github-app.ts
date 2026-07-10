/**
 * Public GitHub App install URL. The slug is configurable so a future app
 * rename does not require a code change; the default is the app the hosted
 * control plane runs as (client id Iv23lisiHwVB3E4A27UF).
 */
export function githubAppInstallUrl(): string {
  const slug = process.env.GITHUB_APP_SLUG?.trim() || "postil-dev";
  return `https://github.com/apps/${slug}/installations/new`;
}
