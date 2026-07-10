import { eq } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import {
  apiBase,
  buildAppJwt,
  getInstallationToken,
  normalizePrivateKey,
} from "@/lib/github/app-auth";
import { redactSecrets } from "@/lib/redact";

/**
 * Installation and organization persistence shared by the webhook receiver
 * and the login-time backfill.
 *
 * Webhooks only cover installations whose lifecycle events fire while this
 * control plane is running; an installation created before the database
 * existed never produces a row, so the dashboard shows nothing to link a
 * signing-in user against. syncInstallationsFromGithub closes that gap by
 * asking the GitHub API, with app credentials, whether the app is installed
 * on each account the user belongs to, and upserting what it finds. Webhooks
 * keep the rows fresh; login makes them converge from GitHub's actual state.
 */

export interface GithubAccount {
  id: number;
  login: string;
  type?: string;
}

export interface RepoSummary {
  id: number;
  full_name: string;
  private: boolean;
}

/** One GitHub account (org or user) to check for an app installation. */
export interface AccountRef {
  githubId: number;
  login: string;
  type: "User" | "Organization";
}

interface InstallationLookup {
  id: number;
  suspended_at?: string | null;
  account?: GithubAccount;
}

async function findByGithubOrgId(githubOrgId: number): Promise<number | undefined> {
  const db = getDb();
  const row = (
    await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.githubOrgId, githubOrgId))
      .limit(1)
  )[0];
  return row?.id;
}

export async function findOrCreateOrg(account: GithubAccount): Promise<number> {
  const db = getDb();
  // Fast path: avoid a write (and burning an identity sequence value) on the
  // overwhelmingly common case where the org already exists.
  const existing = await findByGithubOrgId(account.id);
  if (existing) return existing;

  const slugBase = account.login.toLowerCase();
  // No conflict target: suppress a violation on EITHER unique constraint this
  // row can hit - a slug collision with a different GitHub account (the
  // original case this handled), or a githubOrgId collision from a
  // concurrent webhook for this same account racing the check above. A
  // targeted onConflictDoNothing would only swallow one of the two and throw
  // on the other, so both must fall through to the same re-check below.
  const inserted = await db
    .insert(schema.organizations)
    .values({ slug: slugBase, name: account.login, githubOrgId: account.id })
    .onConflictDoNothing()
    .returning({ id: schema.organizations.id });
  if (inserted[0]) return inserted[0].id;

  // githubOrgId is the true identity: if a concurrent request already
  // inserted it, use that row instead of assuming a slug-only collision.
  const afterConflict = await findByGithubOrgId(account.id);
  if (afterConflict) return afterConflict;

  // githubOrgId still doesn't exist, so the conflict above was the slug
  // colliding with a different GitHub account: disambiguate and retry, still
  // conflict-safe against a second concurrent request for this same account.
  const fallback = await db
    .insert(schema.organizations)
    .values({ slug: `${slugBase}-${account.id}`, name: account.login, githubOrgId: account.id })
    .onConflictDoNothing()
    .returning({ id: schema.organizations.id });
  if (fallback[0]) return fallback[0].id;

  const afterFallback = await findByGithubOrgId(account.id);
  if (!afterFallback) throw new Error("organization insert returned no row");
  return afterFallback;
}

export async function upsertRepositories(
  installationId: number,
  repos: RepoSummary[],
): Promise<void> {
  const db = getDb();
  for (const repo of repos) {
    await db
      .insert(schema.repositories)
      .values({
        installationId,
        githubRepoId: repo.id,
        fullName: repo.full_name,
        private: repo.private,
      })
      .onConflictDoUpdate({
        target: schema.repositories.githubRepoId,
        set: { fullName: repo.full_name, private: repo.private, installationId },
      });
  }
}

/** Upsert the organization + installation pair; returns the installation row id. */
export async function upsertInstallation(
  installation: { id: number; suspended?: boolean },
  account: GithubAccount,
): Promise<number | undefined> {
  const db = getDb();
  const orgId = await findOrCreateOrg(account);
  const upserted = await db
    .insert(schema.installations)
    .values({
      githubInstallationId: installation.id,
      orgId,
      accountLogin: account.login,
      accountType: account.type ?? "User",
      suspended: installation.suspended ?? false,
    })
    .onConflictDoUpdate({
      target: schema.installations.githubInstallationId,
      set: {
        orgId,
        accountLogin: account.login,
        suspended: installation.suspended ?? false,
      },
    })
    .returning({ id: schema.installations.id });
  return upserted[0]?.id;
}

function githubHeaders(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "postil-control-plane",
  };
}

/**
 * Best-effort: bring the organizations/installations/repositories rows for
 * the given accounts in line with GitHub's actual installation state. Never
 * throws; a failure on one account must not break login or the others.
 */
export async function syncInstallationsFromGithub(accounts: AccountRef[]): Promise<void> {
  let jwt: string;
  try {
    const appId = requireEnv("GITHUB_APP_ID");
    const privateKey = normalizePrivateKey(requireEnv("GITHUB_APP_PRIVATE_KEY"));
    jwt = buildAppJwt(appId, privateKey);
  } catch (err) {
    console.error(`installation sync skipped, app credentials unavailable: ${redactSecrets(err)}`);
    return;
  }

  for (const account of accounts) {
    try {
      await syncOneAccount(jwt, account);
    } catch (err) {
      console.error(
        `installation sync failed for ${account.type} ${account.login}: ${redactSecrets(err)}`,
      );
    }
  }
}

async function syncOneAccount(jwt: string, account: AccountRef): Promise<void> {
  const path =
    account.type === "Organization"
      ? `/orgs/${encodeURIComponent(account.login)}/installation`
      : `/users/${encodeURIComponent(account.login)}/installation`;
  const res = await fetch(`${apiBase()}${path}`, { headers: githubHeaders(jwt) });
  // 404 simply means the app is not installed on this account.
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`installation lookup: HTTP ${res.status}`);
  const found = (await res.json()) as InstallationLookup;
  if (typeof found.id !== "number") return;

  const suspended = Boolean(found.suspended_at);
  const installationRowId = await upsertInstallation(
    { id: found.id, suspended },
    // The lookup's account block is authoritative; fall back to what we know.
    found.account ?? { id: account.githubId, login: account.login, type: account.type },
  );
  if (installationRowId === undefined || suspended) return;

  // Backfill repositories only when the installation has none yet: the
  // webhook path owns ongoing repo add/remove events, and a suspended
  // installation cannot mint the token this listing needs.
  const db = getDb();
  const existingRepo = await db
    .select({ id: schema.repositories.id })
    .from(schema.repositories)
    .where(eq(schema.repositories.installationId, installationRowId))
    .limit(1);
  if (existingRepo.length > 0) return;

  const token = await getInstallationToken(found.id);
  // Bounded pagination, same defensive style as the login org walk.
  for (let page = 1; page <= 20; page++) {
    const listRes = await fetch(
      `${apiBase()}/installation/repositories?per_page=100&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (!listRes.ok) throw new Error(`repository listing: HTTP ${listRes.status}`);
    const data = (await listRes.json()) as { repositories?: RepoSummary[] };
    const repos = data.repositories ?? [];
    if (repos.length === 0) break;
    await upsertRepositories(installationRowId, repos);
    if (repos.length < 100) break;
  }
}
