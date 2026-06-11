import { NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { verifyWebhookSignature } from "@/lib/crypto/webhook";
import { getDb, getPool, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import { mentionsPostil } from "@/lib/mentions";
import { enqueueJob, type RespondJobPayload, type ReviewJobPayload } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub webhook receiver.
 *
 * Order matters: signature is verified against the raw body BEFORE any
 * JSON parsing; deliveries are deduped by X-GitHub-Delivery with an
 * insert-or-skip; only then is the event dispatched.
 */

interface GithubAccount {
  id: number;
  login: string;
  type?: string;
}

interface InstallationEventPayload {
  action?: string;
  installation?: {
    id: number;
    account?: GithubAccount;
    suspended_at?: string | null;
  };
  repositories?: RepoSummary[];
  repositories_added?: RepoSummary[];
  repositories_removed?: RepoSummary[];
}

interface RepoSummary {
  id: number;
  full_name: string;
  private: boolean;
}

interface PullRequestEventPayload {
  action?: string;
  number?: number;
  installation?: { id: number };
  repository?: RepoSummary;
  pull_request?: {
    number: number;
    draft?: boolean;
    head?: { sha?: string };
    base?: { sha?: string };
  };
}

const REVIEWABLE_PR_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

interface GithubUser {
  login?: string;
  type?: string;
}

interface CommentEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  sender?: GithubUser;
  comment?: { body?: string; user?: GithubUser };
  issue?: { number: number; body?: string; pull_request?: unknown };
  pull_request?: { number: number };
}

interface IssuesEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  sender?: GithubUser;
  issue?: { number: number; body?: string };
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature(rawBody, signature, requireEnv("GITHUB_WEBHOOK_SECRET"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (!deliveryId || !event) {
    return NextResponse.json({ error: "missing delivery headers" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const action =
    typeof payload === "object" && payload !== null && "action" in payload
      ? String((payload as { action: unknown }).action)
      : null;

  // Dedupe: redeliveries are acknowledged but not reprocessed.
  const db = getDb();
  const dedupe = await db
    .insert(schema.webhookDeliveries)
    .values({ deliveryId, event, action })
    .onConflictDoNothing()
    .returning({ deliveryId: schema.webhookDeliveries.deliveryId });
  if (dedupe.length === 0) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  switch (event) {
    case "installation":
      await handleInstallation(payload as InstallationEventPayload);
      break;
    case "installation_repositories":
      await handleInstallationRepositories(payload as InstallationEventPayload);
      break;
    case "pull_request":
      await handlePullRequest(payload as PullRequestEventPayload);
      break;
    case "issue_comment":
      await handleIssueComment(payload as CommentEventPayload);
      break;
    case "pull_request_review_comment":
      await handleReviewComment(payload as CommentEventPayload);
      break;
    case "issues":
      await handleIssues(payload as IssuesEventPayload);
      break;
    default:
      // Acknowledged, intentionally ignored.
      break;
  }

  return NextResponse.json({ ok: true });
}

async function findOrCreateOrg(account: GithubAccount): Promise<number> {
  const db = getDb();
  const existing = (
    await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.githubOrgId, account.id))
      .limit(1)
  )[0];
  if (existing) return existing.id;
  const slugBase = account.login.toLowerCase();
  const inserted = await db
    .insert(schema.organizations)
    .values({ slug: slugBase, name: account.login, githubOrgId: account.id })
    .onConflictDoNothing({ target: schema.organizations.slug })
    .returning({ id: schema.organizations.id });
  if (inserted[0]) return inserted[0].id;
  // Slug collision with a different GitHub account: disambiguate.
  const fallback = await db
    .insert(schema.organizations)
    .values({ slug: `${slugBase}-${account.id}`, name: account.login, githubOrgId: account.id })
    .returning({ id: schema.organizations.id });
  const row = fallback[0];
  if (!row) throw new Error("organization insert returned no row");
  return row.id;
}

async function upsertRepositories(installationId: number, repos: RepoSummary[]): Promise<void> {
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

async function handleInstallation(payload: InstallationEventPayload): Promise<void> {
  const db = getDb();
  const installation = payload.installation;
  if (!installation?.account) return;

  switch (payload.action) {
    case "created": {
      const orgId = await findOrCreateOrg(installation.account);
      const upserted = await db
        .insert(schema.installations)
        .values({
          githubInstallationId: installation.id,
          orgId,
          accountLogin: installation.account.login,
          accountType: installation.account.type ?? "User",
          suspended: false,
        })
        .onConflictDoUpdate({
          target: schema.installations.githubInstallationId,
          set: { orgId, accountLogin: installation.account.login, suspended: false },
        })
        .returning({ id: schema.installations.id });
      const installationRowId = upserted[0]?.id;
      if (installationRowId !== undefined && payload.repositories) {
        await upsertRepositories(installationRowId, payload.repositories);
      }
      break;
    }
    case "deleted":
      await db
        .delete(schema.installations)
        .where(eq(schema.installations.githubInstallationId, installation.id));
      break;
    case "suspend":
      await db
        .update(schema.installations)
        .set({ suspended: true })
        .where(eq(schema.installations.githubInstallationId, installation.id));
      break;
    case "unsuspend":
      await db
        .update(schema.installations)
        .set({ suspended: false })
        .where(eq(schema.installations.githubInstallationId, installation.id));
      break;
    default:
      break;
  }
}

async function handleInstallationRepositories(
  payload: InstallationEventPayload,
): Promise<void> {
  const db = getDb();
  const installation = payload.installation;
  if (!installation) return;
  const row = (
    await db
      .select({ id: schema.installations.id })
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, installation.id))
      .limit(1)
  )[0];
  if (!row) return;

  if (payload.repositories_added?.length) {
    await upsertRepositories(row.id, payload.repositories_added);
  }
  for (const repo of payload.repositories_removed ?? []) {
    await db
      .delete(schema.repositories)
      .where(eq(schema.repositories.githubRepoId, repo.id));
  }
}

async function handlePullRequest(payload: PullRequestEventPayload): Promise<void> {
  const action = payload.action ?? "";
  if (!REVIEWABLE_PR_ACTIONS.has(action)) return;
  const pr = payload.pull_request;
  const repo = payload.repository;
  const installationId = payload.installation?.id;
  if (!pr || !repo || !installationId) return;
  if (pr.draft) return; // Drafts are reviewed when marked ready.
  const headSha = pr.head?.sha;
  const baseSha = pr.base?.sha;
  if (!headSha || !baseSha) return;

  const db = getDb();
  const installation = (
    await db
      .select({ id: schema.installations.id, suspended: schema.installations.suspended })
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, installationId))
      .limit(1)
  )[0];
  if (!installation || installation.suspended) return;

  const repoRow = await db
    .insert(schema.repositories)
    .values({
      installationId: installation.id,
      githubRepoId: repo.id,
      fullName: repo.full_name,
      private: repo.private,
    })
    .onConflictDoUpdate({
      target: schema.repositories.githubRepoId,
      set: { fullName: repo.full_name, private: repo.private },
    })
    .returning({ enabled: schema.repositories.enabled });
  if (!repoRow[0]?.enabled) return;

  const jobPayload: ReviewJobPayload = {
    installationId,
    repoFullName: repo.full_name,
    prNumber: pr.number,
    headSha,
    baseSha,
  };
  await enqueueJob(getPool(), "review", jobPayload);
}

/**
 * Resolve an enabled, non-suspended repository for a mention event, or null.
 * Mentions only act on repos the installation already tracks and has enabled.
 */
async function enabledRepoForMention(
  installationId: number | undefined,
  repo: RepoSummary | undefined,
): Promise<boolean> {
  if (!installationId || !repo) return false;
  const db = getDb();
  const installation = (
    await db
      .select({ id: schema.installations.id, suspended: schema.installations.suspended })
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, installationId))
      .limit(1)
  )[0];
  if (!installation || installation.suspended) return false;
  const repoRow = (
    await db
      .select({ enabled: schema.repositories.enabled })
      .from(schema.repositories)
      .where(eq(schema.repositories.githubRepoId, repo.id))
      .limit(1)
  )[0];
  return Boolean(repoRow?.enabled);
}

/** Skip our own comments and other bots to avoid mention loops. */
function isBot(user: GithubUser | undefined): boolean {
  return user?.type === "Bot" || Boolean(user?.login && user.login.endsWith("[bot]"));
}

async function enqueueRespond(payload: RespondJobPayload): Promise<void> {
  await enqueueJob(getPool(), "respond", payload, { maxAttempts: 2 });
}

async function handleIssueComment(payload: CommentEventPayload): Promise<void> {
  if (payload.action !== "created") return;
  const body = payload.comment?.body;
  if (!mentionsPostil(body) || isBot(payload.comment?.user) || isBot(payload.sender)) return;
  if (!payload.issue || !payload.repository) return;
  if (!(await enabledRepoForMention(payload.installation?.id, payload.repository))) return;
  await enqueueRespond({
    installationId: payload.installation!.id,
    repoFullName: payload.repository.full_name,
    number: payload.issue.number,
    // GitHub sends issue_comment for PR conversation comments too; the
    // pull_request marker distinguishes them.
    isPr: payload.issue.pull_request != null,
    comment: body!,
  });
}

async function handleReviewComment(payload: CommentEventPayload): Promise<void> {
  if (payload.action !== "created") return;
  const body = payload.comment?.body;
  if (!mentionsPostil(body) || isBot(payload.comment?.user) || isBot(payload.sender)) return;
  if (!payload.pull_request || !payload.repository) return;
  if (!(await enabledRepoForMention(payload.installation?.id, payload.repository))) return;
  await enqueueRespond({
    installationId: payload.installation!.id,
    repoFullName: payload.repository.full_name,
    number: payload.pull_request.number,
    isPr: true,
    comment: body!,
  });
}

async function handleIssues(payload: IssuesEventPayload): Promise<void> {
  // Only the opening of an issue that mentions the bot; edits/labels are noise.
  if (payload.action !== "opened") return;
  const body = payload.issue?.body;
  if (!mentionsPostil(body) || isBot(payload.sender)) return;
  if (!payload.issue || !payload.repository) return;
  if (!(await enabledRepoForMention(payload.installation?.id, payload.repository))) return;
  await enqueueRespond({
    installationId: payload.installation!.id,
    repoFullName: payload.repository.full_name,
    number: payload.issue.number,
    isPr: false,
    comment: body!,
  });
}
