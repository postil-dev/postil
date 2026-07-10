import { NextResponse } from "next/server";

import { and, eq, inArray } from "drizzle-orm";

import { verifyWebhookSignature } from "@/lib/crypto/webhook";
import { getDb, getPool, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import { getInstallationToken } from "@/lib/github/app-auth";
import { ADVISORY_CHECK_NAME, GATE_CHECK_NAME } from "@/lib/github/checks";
import {
  type GithubAccount,
  type RepoSummary,
  upsertInstallation,
  upsertRepositories,
} from "@/lib/github/installation-sync";
import { mentionsPostil } from "@/lib/mentions";
import { enqueueJob, type RespondJobPayload, type ReviewJobPayload } from "@/lib/queue";
import { redactSecrets } from "@/lib/redact";
import { failCheckRuns } from "@/worker/review";
import { readPositiveIntEnv, triggerQueueDrain } from "@/worker/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub webhook receiver.
 *
 * Order matters: signature is verified against the raw body BEFORE any
 * JSON parsing; deliveries are deduped by X-GitHub-Delivery with an
 * insert-or-skip; only then is the event dispatched.
 */

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

/**
 * The subset of a check_run/check_suite `pull_requests[]` entry we need to
 * rebuild a review job. GitHub includes head/base sha on these references
 * even though the top-level check_run/check_suite object does not carry a
 * base sha, so no extra PR lookup is needed before enqueueing.
 */
interface CheckPullRequestRef {
  number: number;
  head?: { sha?: string };
  base?: { sha?: string };
}

interface CheckRunEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  check_run?: {
    name?: string;
    head_sha?: string;
    pull_requests?: CheckPullRequestRef[];
  };
}

interface CheckSuiteEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  check_suite?: {
    head_sha?: string;
    pull_requests?: CheckPullRequestRef[];
  };
}

/**
 * The two check-run names this app creates (see lib/github/checks.ts). A
 * check_run.rerequested only ever names a run this app itself created, but
 * we still gate on it defensively in case the App is ever subscribed to a
 * repo with other checks.
 */
const OWN_CHECK_NAMES = new Set<string>([ADVISORY_CHECK_NAME, GATE_CHECK_NAME]);

interface GithubUser {
  login?: string;
  type?: string;
}

interface CommentEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  sender?: GithubUser;
  comment?: {
    body?: string;
    user?: GithubUser;
    author_association?: string;
    // Present on pull_request_review_comment: the thread's anchor.
    path?: string;
    line?: number;
  };
  issue?: { number: number; body?: string; pull_request?: unknown };
  pull_request?: { number: number };
}

interface IssuesEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  sender?: GithubUser;
  issue?: { number: number; body?: string; author_association?: string };
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

  // The dedupe row is now committed, but the side effect (enqueue / DB writes)
  // has not run yet. If dispatch throws, we must NOT leave the dedupe row
  // behind: GitHub redelivers the same X-GitHub-Delivery, the redelivery would
  // hit `dedupe.length === 0` and be acknowledged as a duplicate, and the event
  // would be permanently lost (the review/reply never runs). So on dispatch
  // failure, delete the dedupe row and return non-2xx; GitHub then retries and
  // the redelivery is processed as fresh. A genuine duplicate still short-
  // circuits above before reaching dispatch.
  try {
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
      case "check_run":
        await handleCheckRun(payload as CheckRunEventPayload);
        break;
      case "check_suite":
        await handleCheckSuite(payload as CheckSuiteEventPayload);
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
  } catch (err) {
    // Roll back the dedupe claim so the redelivery is not dropped. Best-effort:
    // if the cleanup delete itself fails we still return non-2xx so GitHub
    // retries (a stale dedupe row would only resurface as a swallowed
    // duplicate, which is the pre-existing failure mode, not a regression).
    await db
      .delete(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.deliveryId, deliveryId))
      .catch((cleanupErr) => {
        console.error(
          `webhook dispatch failed and dedupe cleanup failed for delivery ${deliveryId}: ${redactSecrets(cleanupErr)}`,
        );
      });
    console.error(
      `webhook dispatch failed for delivery ${deliveryId} (${event}): ${redactSecrets(err)}`,
    );
    return NextResponse.json({ error: "dispatch failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

async function handleInstallation(payload: InstallationEventPayload): Promise<void> {
  const db = getDb();
  const installation = payload.installation;
  if (!installation?.account) return;

  switch (payload.action) {
    case "created": {
      const installationRowId = await upsertInstallation(
        { id: installation.id, suspended: Boolean(installation.suspended_at) },
        installation.account,
      );
      if (installationRowId !== undefined && payload.repositories) {
        await upsertRepositories(installationRowId, payload.repositories);
      }
      break;
    }
    case "deleted":
      // Deleting the installation cascades to its repositories and their
      // reviews, which orphans any in-flight review's check-runs as
      // in_progress. Unlike repositories_removed, the installation's token is
      // revoked the moment it is uninstalled, so there is no way to complete
      // those check-runs from here; just delete.
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
  const removed = payload.repositories_removed ?? [];
  if (removed.length > 0) {
    // The installation is still valid here (only specific repos were removed),
    // so its token is still mintable. Deleting the repository rows cascades to
    // their reviews; complete any in-flight review's check-runs first so they
    // don't hang in_progress forever in the branch-protection UI. Best-effort:
    // a failure to complete must not block the removal.
    await completeRunningReviewsForRemovedRepos(installation.id, removed);
    for (const repo of removed) {
      await db
        .delete(schema.repositories)
        .where(eq(schema.repositories.githubRepoId, repo.id));
    }
  }
}

/**
 * Fail-close the check-runs of any review still `running` for repositories
 * about to be removed from an installation, reusing the watchdog's completion
 * path and wording. Runs before the delete cascades the review rows away.
 */
async function completeRunningReviewsForRemovedRepos(
  githubInstallationId: number,
  removed: RepoSummary[],
): Promise<void> {
  const db = getDb();
  const githubRepoIds = removed.map((r) => r.id);
  const stuck = await db
    .select({
      id: schema.reviews.id,
      advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
      gateCheckRunId: schema.reviews.gateCheckRunId,
      repoFullName: schema.repositories.fullName,
    })
    .from(schema.reviews)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .where(
      and(
        eq(schema.reviews.status, "running"),
        inArray(schema.repositories.githubRepoId, githubRepoIds),
      ),
    );
  if (stuck.length === 0) return;

  const message = "repository removed from the installation before the review completed";
  let token: string;
  try {
    token = await getInstallationToken(githubInstallationId);
  } catch (err) {
    console.error(
      `installation_repositories removed: could not mint token to complete check-runs: ${redactSecrets(err)}`,
    );
    return;
  }
  for (const review of stuck) {
    await db
      .update(schema.reviews)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
      .where(and(eq(schema.reviews.id, review.id), eq(schema.reviews.status, "running")));
    await failCheckRuns(
      token,
      review.repoFullName,
      review.advisoryCheckRunId,
      review.gateCheckRunId,
      message,
    ).catch((err) =>
      console.error(
        `installation_repositories removed: could not complete check-runs for review ${review.id}: ${redactSecrets(err)}`,
      ),
    );
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
      // Re-pin installationId on conflict, matching upsertRepositories: a repo
      // transferred between installations would otherwise stay bound to the old
      // installation, and every review path joins the repo by installationId,
      // so reviews would silently skip.
      set: { fullName: repo.full_name, private: repo.private, installationId: installation.id },
    })
    .returning({ enabled: schema.repositories.enabled });
  if (!repoRow[0]?.enabled) return;

  await enqueueReviewJob({
    installationId,
    repoFullName: repo.full_name,
    prNumber: pr.number,
    headSha,
    baseSha,
  });
}

/**
 * True when a review job for this exact repo+PR+head is already queued or
 * running. Guards the check_run/check_suite rerequest path: unlike
 * pull_request (one delivery per push), GitHub can send a rerequested event
 * per check-run, and a maintainer can also click "Re-run" more than once
 * before the first attempt starts, so the delivery-id dedupe alone is not
 * enough here. Cheap count against the existing jobs table, same pattern as
 * respondRateLimited above; no new table or state.
 */
async function reviewJobInFlight(
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<boolean> {
  const res = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM jobs
      WHERE kind = 'review'
        AND status IN ('queued', 'running')
        AND payload->>'repoFullName' = $1
        AND (payload->>'prNumber')::int = $2
        AND payload->>'headSha' = $3`,
    [repoFullName, prNumber, headSha],
  );
  return Number(res.rows[0]?.count ?? 0) > 0;
}

/**
 * Resolve the enabled, non-suspended installation for `installationId` and
 * enqueue a review job for it. Shared by pull_request and the
 * check_run/check_suite rerequest handlers so both go through the same
 * installation/repo-enabled gate and enqueue semantics.
 */
async function enqueueReviewJob(job: ReviewJobPayload): Promise<void> {
  if (await reviewJobInFlight(job.repoFullName, job.prNumber, job.headSha)) {
    console.log(
      `review job skipped: ${job.repoFullName}#${job.prNumber}@${job.headSha} already queued or running`,
    );
    return;
  }
  await enqueueJob(getPool(), "review", job);
  triggerQueueDrain("review");
}

/**
 * Resolve an enabled, non-suspended repository row for a check_run/check_suite
 * rerequest. Mirrors the installation + repo-enabled gate in handlePullRequest,
 * but does not upsert the repo row: a rerequest only ever targets a repo the
 * app already knows (the check-run was created by a prior pull_request
 * delivery), so if the repo is missing here something is inconsistent and
 * skipping is the safe default rather than materializing a new row.
 */
async function enabledRepoForRerequest(
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
      .where(
        and(
          eq(schema.repositories.githubRepoId, repo.id),
          eq(schema.repositories.installationId, installation.id),
        ),
      )
      .limit(1)
  )[0];
  return Boolean(repoRow?.enabled);
}

/**
 * Shared core for handleCheckRun and handleCheckSuite: both rerequest events
 * carry a repository, installation, head sha, and a `pull_requests[]` ref
 * with head/base shas, and both resolve to the exact same review-job
 * enqueue. `label` and `checkName` only affect log lines.
 *
 * NOTE: this only fires if the GitHub App's webhook subscription includes
 * the check_run (and, for "Re-run all checks", check_suite) event. The app
 * manifest/settings must add it; this handler alone does not turn
 * deliveries on.
 */
async function handleCheckRerequest(
  label: "check_run" | "check_suite",
  checkName: string | undefined,
  repo: RepoSummary | undefined,
  installationId: number | undefined,
  headSha: string | undefined,
  prRefs: CheckPullRequestRef[],
): Promise<void> {
  const suffix = checkName ? ` (${checkName})` : "";
  if (!repo || !installationId || !headSha) {
    console.warn(
      `${label} rerequested: missing repository/installation/head_sha${suffix}; skipping`,
    );
    return;
  }

  if (prRefs.length === 0) {
    // Detached head (e.g. the branch's PR was closed, or the check predates
    // any PR association): nothing to re-review against.
    console.log(
      `${label} rerequested: no associated pull_requests for ${repo.full_name}@${headSha}${suffix}; skipping`,
    );
    return;
  }
  const pr = prRefs[0]!;
  const baseSha = pr.base?.sha;
  if (!baseSha) {
    console.warn(
      `${label} rerequested: pull_requests[0] missing base sha for ${repo.full_name}#${pr.number}${suffix}; skipping`,
    );
    return;
  }

  if (!(await enabledRepoForRerequest(installationId, repo))) return;

  await enqueueReviewJob({
    installationId,
    repoFullName: repo.full_name,
    prNumber: pr.number,
    headSha,
    baseSha,
  });
}

/** Handle GitHub's "Re-run" button on our own check-runs. */
async function handleCheckRun(payload: CheckRunEventPayload): Promise<void> {
  if (payload.action !== "rerequested") return;
  const checkRun = payload.check_run;
  const name = checkRun?.name;
  if (!name || !OWN_CHECK_NAMES.has(name)) return;

  await handleCheckRerequest(
    "check_run",
    name,
    payload.repository,
    payload.installation?.id,
    checkRun?.head_sha,
    checkRun?.pull_requests ?? [],
  );
}

/**
 * Handle GitHub's "Re-run all checks" button, which fires check_suite
 * rerequested rather than one check_run event per run.
 */
async function handleCheckSuite(payload: CheckSuiteEventPayload): Promise<void> {
  if (payload.action !== "rerequested") return;
  const suite = payload.check_suite;

  await handleCheckRerequest(
    "check_suite",
    undefined,
    payload.repository,
    payload.installation?.id,
    suite?.head_sha,
    suite?.pull_requests ?? [],
  );
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
  // Defense in depth: require the repo row to belong to the claimed
  // installation, matching the worker path (review.ts / respond.ts both join
  // the repo via installationId). Without the join, a signature-valid payload
  // claiming installation A plus a repo row owned by installation B would pass
  // the enabled check; here we reject that mismatch at the webhook gate rather
  // than relying solely on GitHub's downstream token scoping.
  const repoRow = (
    await db
      .select({ enabled: schema.repositories.enabled })
      .from(schema.repositories)
      .where(
        and(
          eq(schema.repositories.githubRepoId, repo.id),
          eq(schema.repositories.installationId, installation.id),
        ),
      )
      .limit(1)
  )[0];
  return Boolean(repoRow?.enabled);
}

/** Skip our own comments and other bots to avoid mention loops. */
function isBot(user: GithubUser | undefined): boolean {
  return user?.type === "Bot" || Boolean(user?.login && user.login.endsWith("[bot]"));
}

/**
 * Only privileged repo affiliations may summon the bot. Every respond job
 * spends LLM tokens on the org's (or our) API key, so an open trigger lets
 * any drive-by commenter burn the budget by spamming @postil on a public
 * repo. Anything outside this set is dropped silently.
 */
const RESPOND_ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function mayTriggerRespond(authorAssociation: string | undefined): boolean {
  return Boolean(authorAssociation && RESPOND_ALLOWED_ASSOCIATIONS.has(authorAssociation));
}

/**
 * Per-installation cap on @postil respond jobs enqueued per rolling hour.
 * Every respond job spends LLM tokens, so a burst of qualifying comments must
 * not translate one-to-one into jobs. Configurable via env; default 30/hour.
 */
function respondHourlyCap(): number {
  return readPositiveIntEnv("POSTIL_RESPOND_HOURLY_CAP", 30);
}

/**
 * True when this installation has already enqueued at least `cap` respond jobs
 * in the last hour. Cheap count against the existing jobs table keyed on the
 * payload's installationId; no new table or state.
 */
async function respondRateLimited(installationId: number, cap: number): Promise<boolean> {
  const res = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM jobs
      WHERE kind = 'respond'
        AND created_at >= now() - interval '1 hour'
        AND (payload->>'installationId')::bigint = $1`,
    [installationId],
  );
  return Number(res.rows[0]?.count ?? 0) >= cap;
}

// Respond jobs share the delivery-id dedupe at the top of POST: a redelivered
// issue_comment/issues event is acknowledged as duplicate before dispatch, so
// it can never enqueue a second bot reply.
async function enqueueRespond(payload: RespondJobPayload): Promise<void> {
  const cap = respondHourlyCap();
  if (await respondRateLimited(payload.installationId, cap)) {
    console.warn(
      `respond job skipped: installation ${payload.installationId} exceeded ${cap} respond jobs/hour`,
    );
    return;
  }
  await enqueueJob(getPool(), "respond", payload, { maxAttempts: 2 });
  triggerQueueDrain("respond");
}

async function handleIssueComment(payload: CommentEventPayload): Promise<void> {
  if (payload.action !== "created") return;
  const body = payload.comment?.body;
  if (!mentionsPostil(body) || isBot(payload.comment?.user) || isBot(payload.sender)) return;
  if (!mayTriggerRespond(payload.comment?.author_association)) return;
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
  if (!mayTriggerRespond(payload.comment?.author_association)) return;
  if (!payload.pull_request || !payload.repository) return;
  if (!(await enabledRepoForMention(payload.installation?.id, payload.repository))) return;
  // Review comments anchor to a file/line; without it the bot answers blind
  // to which code the question is about.
  const anchor =
    payload.comment?.path != null
      ? `${payload.comment.path}${payload.comment.line != null ? `:${payload.comment.line}` : ""}`
      : undefined;
  await enqueueRespond({
    installationId: payload.installation!.id,
    repoFullName: payload.repository.full_name,
    number: payload.pull_request.number,
    isPr: true,
    comment: body!,
    commentAnchor: anchor,
  });
}

async function handleIssues(payload: IssuesEventPayload): Promise<void> {
  // Only the opening of an issue that mentions the bot; edits/labels are noise.
  if (payload.action !== "opened") return;
  const body = payload.issue?.body;
  if (!mentionsPostil(body) || isBot(payload.sender)) return;
  if (!mayTriggerRespond(payload.issue?.author_association)) return;
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
