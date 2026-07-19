import { eq } from "drizzle-orm";

import { getDb, getPool, schema } from "@/lib/db";
import { hostedInferenceAvailable, requireEnv } from "@/lib/env";
import {
  apiBase,
  buildAppJwt,
  getInstallationToken,
  normalizePrivateKey,
} from "@/lib/github/app-auth";
import { redactSecrets } from "@/lib/redact";
import { recordRepositoryEnablementEvent } from "@/lib/repository-enablement";
import { grantSelfServiceTrial } from "@/lib/self-service-trial";

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

/** Read current repository visibility with an installation token. */
export async function fetchRepositorySummary(
  token: string,
  repoFullName: string,
  signal?: AbortSignal,
): Promise<RepoSummary> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const response = await fetch(`${apiBase()}/repos/${repoFullName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: requestSignal,
  });
  if (!response.ok) {
    throw new Error(`GitHub repository lookup failed with HTTP ${response.status}`);
  }
  const value = (await response.json()) as Partial<RepoSummary>;
  if (
    typeof value.id !== "number" ||
    typeof value.full_name !== "string" ||
    typeof value.private !== "boolean"
  ) {
    throw new Error("GitHub repository lookup returned an invalid response");
  }
  return { id: value.id, full_name: value.full_name, private: value.private };
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
  for (const repo of repos) {
    await upsertRepository(installationId, repo, "github_installation");
  }
}

export async function upsertRepository(
  installationId: number,
  repo: RepoSummary,
  source: "github_installation" | "github_pull_request",
): Promise<{ id: number; enabled: boolean } | undefined> {
  const db = getDb();
  const destination = (
    await db
      .select({ orgId: schema.installations.orgId })
      .from(schema.installations)
      .where(eq(schema.installations.id, installationId))
      .limit(1)
  )[0];
  if (!destination) return undefined;

  return db.transaction(async (tx) => {
    const loadExisting = async () =>
      (
        await tx
          .select({
            id: schema.repositories.id,
            installationId: schema.repositories.installationId,
            fullName: schema.repositories.fullName,
            private: schema.repositories.private,
            enabled: schema.repositories.enabled,
            orgId: schema.installations.orgId,
          })
          .from(schema.repositories)
          .innerJoin(
            schema.installations,
            eq(schema.installations.id, schema.repositories.installationId),
          )
          .where(eq(schema.repositories.githubRepoId, repo.id))
          .limit(1)
      )[0];

    let existing = await loadExisting();

    if (!existing) {
      const [inserted] = await tx
        .insert(schema.repositories)
        .values({
          installationId,
          githubRepoId: repo.id,
          fullName: repo.full_name,
          private: repo.private,
        })
        .onConflictDoNothing({ target: schema.repositories.githubRepoId })
        .returning({ id: schema.repositories.id, enabled: schema.repositories.enabled });
      if (inserted) {
        if (destination.orgId !== null) {
          await recordRepositoryEnablementEvent(tx, {
            orgId: destination.orgId,
            repositoryId: inserted.id,
            githubRepoId: repo.id,
            repositoryFullName: repo.full_name,
            repositoryPrivate: repo.private,
            action: "enable",
            source,
          });
        }
        return inserted;
      }
      existing = await loadExisting();
      if (!existing) return undefined;
    }

    const orgChanged = existing.orgId !== destination.orgId;
    if (orgChanged && existing.enabled && existing.orgId !== null) {
      await recordRepositoryEnablementEvent(tx, {
        orgId: existing.orgId,
        repositoryId: existing.id,
        githubRepoId: repo.id,
        repositoryFullName: existing.fullName,
        repositoryPrivate: existing.private,
        action: "disable",
        source: "github_transfer",
      });
    }

    const [saved] = await tx
      .update(schema.repositories)
      .set({ fullName: repo.full_name, private: repo.private, installationId })
      .where(eq(schema.repositories.id, existing.id))
      .returning({ id: schema.repositories.id, enabled: schema.repositories.enabled });

    if (orgChanged && saved?.enabled && destination.orgId !== null) {
      await recordRepositoryEnablementEvent(tx, {
        orgId: destination.orgId,
        repositoryId: saved.id,
        githubRepoId: repo.id,
        repositoryFullName: repo.full_name,
        repositoryPrivate: repo.private,
        action: "enable",
        source: "github_transfer",
      });
    }

    return saved;
  });
}

/** Upsert the organization + installation pair; returns the installation row id. */
export async function upsertInstallation(
  installation: { id: number; suspended?: boolean },
  account: GithubAccount,
  initiatedByGithubId?: number,
): Promise<number | undefined> {
  const db = getDb();
  const orgId = await findOrCreateOrg(account);
  const accountType = account.type ?? "User";
  const saved = await db.transaction(async (tx) => {
    const upserted = await tx
      .insert(schema.installations)
      .values({
        githubInstallationId: installation.id,
        orgId,
        accountLogin: account.login,
        accountType,
        suspended: installation.suspended ?? false,
      })
      .onConflictDoUpdate({
        target: schema.installations.githubInstallationId,
        set: {
          orgId,
          accountLogin: account.login,
          accountType,
          suspended: installation.suspended ?? false,
        },
      })
      .returning({ id: schema.installations.id });
    const installationRowId = upserted[0]?.id;
    if (installationRowId === undefined) return undefined;
    const organization = (
      await tx
        .select({ slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1)
    )[0];
    if (!organization) throw new Error("installation organization is missing");

    return { installationRowId, orgSlug: organization.slug };
  });
  if (!saved) return undefined;
  if (!(installation.suspended ?? false)) {
    const actorIdentityVerified = initiatedByGithubId !== undefined;
    await grantSelfServiceTrial(db, {
      orgId,
      orgSlug: saved.orgSlug,
      accountLogin: account.login,
      accountType,
      githubOwnerId: account.id,
      githubInstallationId: installation.id,
      initiatedByGithubId: initiatedByGithubId ?? account.id,
      subscriptionMode:
        actorIdentityVerified && await hostedInferenceAvailable(getPool())
          ? "hosted"
          : "byok",
    });
  }
  return saved.installationRowId;
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
export async function syncInstallationsFromGithub(
  accounts: AccountRef[],
  initiatedByGithubId?: number,
): Promise<void> {
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
      await syncOneAccount(jwt, account, initiatedByGithubId);
    } catch (err) {
      console.error(
        `installation sync failed for ${account.type} ${account.login}: ${redactSecrets(err)}`,
      );
    }
  }
}

async function syncOneAccount(
  jwt: string,
  account: AccountRef,
  initiatedByGithubId?: number,
): Promise<void> {
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
    initiatedByGithubId,
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
