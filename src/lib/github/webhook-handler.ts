/** Signed GitHub webhook acceptance and durable event dispatch. */
import { after, NextResponse } from "next/server";

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { readBoundedWebhookBody, verifyWebhookSignature } from "@/lib/crypto/webhook";
import {
  enqueueCustomerNotification,
  installationRemovedNotification,
} from "@/lib/customer-notifications";
import { getDb, getPool, schema, type Database } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import { getInstallationToken } from "@/lib/github/app-auth";
import { loadLiveApprovalActor } from "@/lib/github/approval-actor";
import {
  ADVISORY_CHECK_NAME,
  GATE_CHECK_NAME,
  checkRunExternalId,
  getPullRequestReviewComment,
  getPullRequestHeadSha,
  getPullRequestReviewContext,
} from "@/lib/github/checks";
import {
  boundedThreadContext,
  isAcceptableConversationRequest,
  isClarificationRequest,
  isGratitudeOnly,
  isPostilBotLogin,
} from "@/lib/github/conversation";
import {
  type GithubAccount,
  type RepoSummary,
  suspendInstallation,
  upsertInstallation,
  upsertRepository,
  upsertRepositories,
} from "@/lib/github/installation-sync";
import {
  enqueueGateStateSync,
  findDismissibleFindingState,
  findKindBlockingState,
  getReviewApprovalState,
  hasInFlightReviewForPr,
  hasNewerCompletedReviewForHead,
  hasNewerReviewForPr,
  insertFindingApproval,
  lockActiveReviewState,
  lockReviewApprovalState,
  loadLatestCompletedReviewForPr,
  revokeFindingApproval,
  resolveApprovableFindingId,
  resolveDismissibleFindingId,
  updateStoredEffectiveGate,
} from "@/lib/finding-approvals";
import { lockOrganizationGateMode } from "@/lib/gate-mode";
import { reviewDetailsUrl } from "@/lib/oauth";
import {
  isPostilReviewCommand,
  mentionsPostil,
  parsePostilApproveCommand,
  parsePostilDismissCommand,
} from "@/lib/mentions";
import { canProcessRepositoryInference } from "@/lib/private-repository-entitlement";
import {
  applyPublicationThreadObservations,
  assertOneFindingPerGithubComment,
  recordPublicationThreadObservations,
  resolveFindingPublicationBinding,
  type PublicationThreadObservation,
} from "@/lib/publication-receipt";
import {
  hasGitHubRepositoryWriteAuthority,
  observeGitHubReviewThreads,
} from "@/lib/github/publication-threads";
import {
  enqueueOperatorAlert,
  installationRemovedAlertPayload,
} from "@/lib/operator-alerts";
import {
  acceptWebhookDelivery,
  cancelPullRequestPublication,
  enqueueGithubReactionJobOnce,
  enqueueRespondJobWithinHourlyCap,
  enqueueReviewJobOnce,
  type RespondJobPayload,
  type ReviewJobPayload,
  type WebhookCommentJobPayload,
} from "@/lib/queue";
import { redactSecrets } from "@/lib/redact";
import {
  recordRepositoryEnablementEvent,
  type RepositoryEnablementSource,
} from "@/lib/repository-enablement";
import { supersedeActiveReviews } from "@/worker/review";
import {
  drainWebhookDispatch,
  readPositiveIntEnv,
  triggerQueueDrain,
} from "@/worker/runner";

/**
 * GitHub webhook receiver.
 *
 * Order matters: signature is verified against the raw body BEFORE any
 * JSON parsing; the signed payload and one dispatch job commit atomically by
 * X-GitHub-Delivery; event processing runs from that durable inbox.
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
  sender?: GithubUser;
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
    updated_at?: string;
    user?: GithubUser;
  };
}

const REVIEWABLE_PR_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "edited",
]);

export type PullRequestStateConvergence = "apply" | "retry" | "ignore";

/** Resolve a signed open/closed transition against GitHub's live snapshot. */
export function pullRequestStateConvergence(
  action: string,
  eventUpdatedAt: string,
  live: { open: boolean; merged: boolean; updatedAt: string },
): PullRequestStateConvergence {
  const eventTime = Date.parse(eventUpdatedAt);
  const liveTime = Date.parse(live.updatedAt);
  if (!Number.isFinite(eventTime) || !Number.isFinite(liveTime)) {
    throw new TypeError("pull request state timestamps must be valid");
  }
  const eventIsOpen = action !== "closed";
  const liveIsOpen = live.open && !live.merged;
  if (eventIsOpen === liveIsOpen) return "apply";
  return liveTime > eventTime ? "ignore" : "retry";
}

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
  id?: number;
  login?: string;
  type?: string;
}

interface CommentEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  sender?: GithubUser;
  comment?: {
    id?: number;
    html_url?: string;
    body?: string;
    user?: GithubUser;
    author_association?: string;
    // Present on pull_request_review_comment: the thread's anchor.
    path?: string;
    line?: number;
    in_reply_to_id?: number;
  };
  issue?: { number: number; body?: string; pull_request?: unknown };
  pull_request?: { number: number };
}

interface ReviewThreadEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  sender?: GithubUser;
  pull_request?: { number?: number };
  thread?: {
    updated_at?: string | null;
  };
}

interface IssuesEventPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoSummary;
  sender?: GithubUser;
  issue?: { number: number; body?: string; author_association?: string };
}

export async function POST(request: Request): Promise<NextResponse> {
  const bodyResult = await readBoundedWebhookBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: bodyResult.status === 413 ? "payload too large" : "invalid body" },
      { status: bodyResult.status },
    );
  }
  const rawBody = bodyResult.body;
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
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const action =
    typeof payload === "object" && payload !== null && "action" in payload
      ? String((payload as { action: unknown }).action)
      : null;
  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  let acceptance: "queued" | "inflight" | "duplicate";
  try {
    acceptance = await acceptWebhookDelivery(getPool(), {
      deliveryId,
      event,
      action,
      payload,
    });
  } catch (err) {
    console.error(
      `webhook acceptance failed for delivery ${deliveryId} (${event}): ${redactSecrets(err)}`,
    );
    return NextResponse.json({ error: "acceptance failed" }, { status: 500 });
  }
  if (acceptance === "duplicate") {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  if (process.env.NODE_ENV !== "test") {
    after(async () => {
      await drainWebhookDispatch(deliveryId, `webhook:${deliveryId}`).catch((err) => {
        console.error(
          `webhook dispatch scheduling failed for delivery ${deliveryId}: ${redactSecrets(err)}`,
        );
      });
    });
  }
  if (acceptance === "inflight") {
    return NextResponse.json({ ok: true, inflight: true });
  }
  return NextResponse.json({ ok: true, queued: true });
}

/** Dispatch one delivery loaded from the durable inbox by a queue worker. */
export async function dispatchWebhookDelivery(
  event: string,
  payload: unknown,
  options: { deliveryId: string; triggerFollowupDrain?: boolean },
): Promise<void> {
  const triggerFollowupDrain = options.triggerFollowupDrain ?? true;
  switch (event) {
    case "installation":
      await handleInstallation(payload as InstallationEventPayload, options.deliveryId);
      break;
    case "installation_repositories":
      await handleInstallationRepositories(payload as InstallationEventPayload);
      break;
    case "pull_request":
      await handlePullRequest(
        payload as PullRequestEventPayload,
        options.deliveryId,
        triggerFollowupDrain,
      );
      break;
    case "check_run":
      await handleCheckRun(
        payload as CheckRunEventPayload,
        options.deliveryId,
        triggerFollowupDrain,
      );
      break;
    case "check_suite":
      await handleCheckSuite(
        payload as CheckSuiteEventPayload,
        options.deliveryId,
        triggerFollowupDrain,
      );
      break;
    case "issue_comment":
      await handleIssueComment(
        payload as CommentEventPayload,
        options.deliveryId,
        triggerFollowupDrain,
      );
      break;
    case "pull_request_review_comment":
      await handleReviewComment(
        payload as CommentEventPayload,
        options.deliveryId,
        triggerFollowupDrain,
      );
      break;
    case "pull_request_review_thread":
      await handleReviewThread(
        payload as ReviewThreadEventPayload,
        options.deliveryId,
        triggerFollowupDrain,
      );
      break;
    case "issues":
      await handleIssues(
        payload as IssuesEventPayload,
        options.deliveryId,
        triggerFollowupDrain,
      );
      break;
    default:
      break;
  }
}

async function handleInstallation(
  payload: InstallationEventPayload,
  sourceEventId: string,
): Promise<void> {
  const db = getDb();
  const installation = payload.installation;
  const account = installation?.account;
  if (!installation || !account) return;

  switch (payload.action) {
    case "created": {
      const installationRowId = await upsertInstallation(
        { id: installation.id, suspended: Boolean(installation.suspended_at) },
        account,
        payload.sender?.id,
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
      await db.transaction(async (tx) => {
        const existing = (
          await tx
            .select({
              orgId: schema.installations.orgId,
              orgSlug: schema.organizations.slug,
              githubOwnerId: schema.organizations.githubOrgId,
              accountLogin: schema.installations.accountLogin,
              accountType: schema.installations.accountType,
            })
            .from(schema.installations)
            .innerJoin(
              schema.organizations,
              eq(schema.organizations.id, schema.installations.orgId),
            )
            .where(eq(schema.installations.githubInstallationId, installation.id))
            .limit(1)
        )[0];
        await recordEnabledRepositoryRemovals(tx, installation.id, "github_uninstall");
        if (existing?.orgId !== null && existing?.orgId !== undefined) {
          await tx
            .delete(schema.orgConfigSnapshots)
            .where(eq(schema.orgConfigSnapshots.orgId, existing.orgId));
          await enqueueOperatorAlert(
            tx,
            installationRemovedAlertPayload({
              orgId: existing.orgId,
              orgSlug: existing.orgSlug,
              accountLogin: existing.accountLogin,
              accountType: existing.accountType,
              githubOwnerId: existing.githubOwnerId ?? account.id,
              githubInstallationId: installation.id,
            }),
          );
          await enqueueCustomerNotification(
            tx,
            installationRemovedNotification({
              orgId: existing.orgId,
              orgSlug: existing.orgSlug,
              githubInstallationId: installation.id,
              sourceEventId,
            }),
          );
        }
        await tx
          .delete(schema.installations)
          .where(eq(schema.installations.githubInstallationId, installation.id));
      });
      break;
    case "suspend":
      await suspendInstallation(installation.id, sourceEventId);
      break;
    case "unsuspend":
      await upsertInstallation(
        { id: installation.id, suspended: false },
        account,
        payload.sender?.id,
        sourceEventId,
      );
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
    const cleanupQueued = await removeRepositoriesWithReviewCleanup(
      db,
      row.id,
      installation.id,
      removed,
    );
    if (cleanupQueued > 0) triggerQueueDrain("repository-removal-check-cleanup");
  }
}

async function recordEnabledRepositoryRemovals(
  db: Pick<Database, "select" | "insert">,
  githubInstallationId: number,
  source: RepositoryEnablementSource,
  githubRepoIds?: number[],
): Promise<void> {
  const filters = [
    eq(schema.installations.githubInstallationId, githubInstallationId),
    eq(schema.repositories.enabled, true),
  ];
  if (githubRepoIds && githubRepoIds.length > 0) {
    filters.push(inArray(schema.repositories.githubRepoId, githubRepoIds));
  }
  const repos = await db
    .select({
      orgId: schema.installations.orgId,
      repositoryId: schema.repositories.id,
      githubRepoId: schema.repositories.githubRepoId,
      fullName: schema.repositories.fullName,
      private: schema.repositories.private,
    })
    .from(schema.repositories)
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(and(...filters));

  for (const repo of repos) {
    if (repo.orgId === null) continue;
    await recordRepositoryEnablementEvent(db, {
      orgId: repo.orgId,
      repositoryId: repo.repositoryId,
      githubRepoId: repo.githubRepoId,
      repositoryFullName: repo.fullName,
      repositoryPrivate: repo.private,
      action: "disable",
      source,
    });
  }
}

/**
 * Lock exact repository identities before scanning their active reviews. A
 * review insert takes a foreign-key key-share lock on the same repository row,
 * so it either commits before this lock and is included in cleanup or waits
 * until deletion commits and fails without creating forge checks.
 */
async function removeRepositoriesWithReviewCleanup(
  db: Database,
  installationId: number,
  githubInstallationId: number,
  removed: RepoSummary[],
): Promise<number> {
  const githubRepoIds = removed.map((r) => r.id);
  const message = "repository removed from the installation before the review completed";
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql<{ repositoryId: number }>`
      SELECT /* postil:repository-removal-lock */
             ${schema.repositories.id}::float8 AS "repositoryId"
      FROM ${schema.repositories}
      WHERE ${schema.repositories.installationId} = ${installationId}
        AND ${schema.repositories.githubRepoId} IN (
          ${sql.join(githubRepoIds.map((id) => sql`${id}`), sql`, `)}
        )
      ORDER BY ${schema.repositories.id}
      FOR UPDATE
    `);
    const repositoryIds = locked.rows.map((repo) => Number(repo.repositoryId));
    if (repositoryIds.length === 0) return 0;

    await recordEnabledRepositoryRemovals(
      tx,
      githubInstallationId,
      "github_installation",
      githubRepoIds,
    );
    const running = await tx
      .select({
        id: schema.reviews.id,
        publicId: schema.reviews.publicId,
        headSha: schema.reviews.headSha,
        advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
        gateCheckRunId: schema.reviews.gateCheckRunId,
        repoFullName: schema.repositories.fullName,
        orgSlug: schema.organizations.slug,
      })
      .from(schema.reviews)
      .innerJoin(
        schema.repositories,
        eq(schema.repositories.id, schema.reviews.repositoryId),
      )
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .leftJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.installations.orgId),
      )
      .where(
        and(
          eq(schema.reviews.status, "running"),
          inArray(schema.repositories.id, repositoryIds),
        ),
      );

    let queued = 0;
    for (const review of running) {
      const detailsUrl = reviewDetailsUrl(review.publicId, review.orgSlug);
      const rows = await tx
        .update(schema.reviews)
        .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
        .where(
          and(
            eq(schema.reviews.id, review.id),
            eq(schema.reviews.status, "running"),
          ),
        )
        .returning({ id: schema.reviews.id });
      if (rows.length === 0) continue;
      await tx.insert(schema.jobs).values({
        kind: "check-run-cleanup",
        payload: {
          installationId: githubInstallationId,
          repoFullName: review.repoFullName,
          advisoryCheckRunId: review.advisoryCheckRunId,
          gateCheckRunId: review.gateCheckRunId,
          headSha: review.headSha,
          advisoryCheckExternalId: checkRunExternalId(review.publicId, "review"),
          gateCheckExternalId: checkRunExternalId(review.publicId, "gate"),
          advisoryCheckRunMayExist: review.advisoryCheckRunId == null,
          gateCheckRunMayExist: review.gateCheckRunId == null,
          message,
          detailsUrl,
          intent: "fail",
        },
        maxAttempts: 5,
      });
      queued += 1;
    }

    await tx
      .delete(schema.repositories)
      .where(inArray(schema.repositories.id, repositoryIds));
    return queued;
  });
}

async function handlePullRequest(
  payload: PullRequestEventPayload,
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
): Promise<void> {
  const action = payload.action ?? "";
  if (!REVIEWABLE_PR_ACTIONS.has(action) && action !== "closed") return;
  const pr = payload.pull_request;
  const repo = payload.repository;
  const installationId = payload.installation?.id;
  if (!pr || !repo || !installationId) return;
  const token = await getInstallationToken(installationId);
  const live = await getPullRequestReviewContext(token, repo.full_name, pr.number);
  const eventHeadSha = pr.head?.sha;
  const eventBaseSha = pr.base?.sha;
  const eventUpdatedAt = pr.updated_at;
  const eventUpdatedTime = Date.parse(eventUpdatedAt ?? "");
  if (!eventHeadSha || !eventBaseSha || !Number.isFinite(eventUpdatedTime)) return;
  const stateConvergence = pullRequestStateConvergence(
    action,
    eventUpdatedAt!,
    live,
  );
  if (stateConvergence === "ignore") return;
  if (
    stateConvergence === "retry" ||
    (action === "ready_for_review" &&
      live.draft &&
      Date.parse(live.updatedAt) <= eventUpdatedTime)
  ) {
    throw new Error(
      `GitHub pull request ${repo.full_name}#${pr.number} has not converged to the signed ${action} transition`,
    );
  }
  if (action !== "closed" && live.draft) return;

  // GitHub's pull-request REST snapshot can lag the signed synchronize event.
  // Retain that event for worker-side convergence. When the live snapshot is
  // newer, repair toward its current head instead of allowing a stale delivery
  // to replace it or leave it without a review owner.
  const liveLagsEvent = Date.parse(live.updatedAt) < eventUpdatedTime;
  const headSha = liveLagsEvent ? eventHeadSha : live.headSha;
  const baseSha = liveLagsEvent ? eventBaseSha : live.baseSha;
  const expectedPullRequestUpdatedAt = liveLagsEvent
    ? eventUpdatedAt!
    : live.updatedAt;

  const db = getDb();
  const installation = (
    await db
      .select({
        id: schema.installations.id,
        orgId: schema.installations.orgId,
        orgSlug: schema.organizations.slug,
        suspended: schema.installations.suspended,
      })
      .from(schema.installations)
      .leftJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.installations.orgId),
      )
      .where(eq(schema.installations.githubInstallationId, installationId))
      .limit(1)
  )[0];
  if (!installation || installation.suspended || installation.orgId === null) return;

  const repoRow = await upsertRepository(installation.id, repo, "github_pull_request");
  if (!repoRow?.enabled) return;
  if (action === "closed") {
    await cancelPullRequestPublication(getPool(), {
      installationId,
      sourceInstallationId: installation.id,
      sourceOrgId: installation.orgId,
      githubRepoId: repo.id,
      repoFullName: repo.full_name,
      prNumber: pr.number,
    });
    await supersedeActiveReviews({
      repositoryId: repoRow.id,
      prNumber: pr.number,
      newHeadSha: headSha,
      repoFullName: repo.full_name,
      githubInstallationId: installationId,
      message: `pull request #${pr.number} closed`,
      orgSlug: installation.orgSlug,
    });
    return;
  }
  if (
    !(await canProcessRepositoryInference(db, {
      orgId: installation.orgId,
      repositoryPrivate: repo.private,
    })).allowed
  ) {
    console.log(`private review skipped: ${repo.full_name} requires billing`);
    return;
  }

  const queuedReviewId = await enqueueReviewJob({
    installationId,
    sourceInstallationId: installation.id,
    sourceOrgId: installation.orgId,
    githubRepoId: repo.id,
    repoFullName: repo.full_name,
    repositoryPrivate: repo.private,
    prNumber: pr.number,
    ...(typeof pr.user?.id === "number"
      ? { authorGithubId: pr.user.id }
      : typeof live.authorGithubId === "number"
        ? { authorGithubId: live.authorGithubId }
        : {}),
    ...(pr.user?.login
      ? { authorLogin: pr.user.login }
      : live.authorLogin
        ? { authorLogin: live.authorLogin }
        : {}),
    headSha,
    baseSha,
    expectedPullRequestUpdatedAt,
    sourceDeliveryId,
    ...(["edited", "reopened", "synchronize"].includes(action)
      ? { forceFullReview: true }
      : {}),
    trigger: {
      source: "automatic_pull_request",
      webhookDeliveryId: sourceDeliveryId,
      webhookEvent: "pull_request",
      webhookAction: action,
    },
  }, false);

  await supersedeActiveReviews({
    repositoryId: repoRow.id,
    prNumber: pr.number,
    newHeadSha: headSha,
    repoFullName: repo.full_name,
    githubInstallationId: installationId,
    onlyDifferentHead: true,
    orgSlug: installation.orgSlug,
  });
  if (queuedReviewId !== null && triggerFollowupDrain) {
    triggerQueueDrain("review");
  }
}

/**
 * Resolve the enabled, non-suspended installation for `installationId` and
 * enqueue a review job for it. Shared by pull_request and the
 * check_run/check_suite rerequest handlers so both go through the same
 * installation/repo-enabled gate and enqueue semantics.
 */
async function enqueueReviewJob(
  job: ReviewJobPayload,
  triggerFollowupDrain: boolean,
): Promise<number | null> {
  const id = await enqueueReviewJobOnce(getPool(), job);
  if (id === null) {
    console.log(
      `review job skipped: ${job.repoFullName}#${job.prNumber}@${job.headSha} already queued or running`,
    );
    return null;
  }
  if (triggerFollowupDrain) triggerQueueDrain("review");
  return id;
}

/**
 * Resolve an enabled, non-suspended repository row for a check_run/check_suite
 * rerequest. The signed repository snapshot updates stored name and visibility
 * before the same entitlement check used by pull_request deliveries.
 */
async function enabledRepoForRerequest(
  installationId: number | undefined,
  repo: RepoSummary | undefined,
): Promise<{ sourceInstallationId: number; sourceOrgId: number; githubRepoId: number } | null> {
  if (!installationId || !repo) return null;
  const db = getDb();
  const installation = (
    await db
      .select({
        id: schema.installations.id,
        orgId: schema.installations.orgId,
        suspended: schema.installations.suspended,
      })
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, installationId))
      .limit(1)
  )[0];
  if (!installation || installation.suspended || installation.orgId === null) return null;
  const repoRow = await upsertRepository(installation.id, repo, "github_pull_request");
  if (!repoRow?.enabled) return null;
  const allowed = (
    await canProcessRepositoryInference(db, {
      orgId: installation.orgId,
      repositoryPrivate: repo.private,
    })
  ).allowed;
  return allowed ? {
    sourceInstallationId: installation.id,
    sourceOrgId: installation.orgId,
    githubRepoId: repo.id,
  } : null;
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
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
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

  const authority = await enabledRepoForRerequest(installationId, repo);
  if (!authority) return;
  const token = await getInstallationToken(installationId);
  const context = await getPullRequestReviewContext(token, repo.full_name, pr.number);
  if (
    !context.open ||
    context.merged ||
    context.draft ||
    context.headSha !== headSha ||
    context.baseSha !== baseSha
  ) return;

  await enqueueReviewJob({
    installationId,
    ...authority,
    repoFullName: repo.full_name,
    repositoryPrivate: repo.private,
    prNumber: pr.number,
    headSha,
    baseSha,
    expectedPullRequestUpdatedAt: context.updatedAt,
    sourceDeliveryId,
    forceFullReview: true,
    trigger: {
      source: "github_check_rerun",
      webhookDeliveryId: sourceDeliveryId,
      webhookEvent: label,
      webhookAction: "rerequested",
      ...(checkName ? { checkName } : {}),
    },
  }, triggerFollowupDrain);
}

/** Handle GitHub's "Re-run" button on our own check-runs. */
async function handleCheckRun(
  payload: CheckRunEventPayload,
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
): Promise<void> {
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
    sourceDeliveryId,
    triggerFollowupDrain,
  );
}

/**
 * Handle GitHub's "Re-run all checks" button, which fires check_suite
 * rerequested rather than one check_run event per run.
 */
async function handleCheckSuite(
  payload: CheckSuiteEventPayload,
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
): Promise<void> {
  if (payload.action !== "rerequested") return;
  const suite = payload.check_suite;

  await handleCheckRerequest(
    "check_suite",
    undefined,
    payload.repository,
    payload.installation?.id,
    suite?.head_sha,
    suite?.pull_requests ?? [],
    sourceDeliveryId,
    triggerFollowupDrain,
  );
}

/**
 * Resolve an enabled, non-suspended repository for a mention event, or null.
 * Mentions only act on repos the installation already tracks and has enabled.
 */
async function enabledRepoForMention(
  installationId: number | undefined,
  repo: RepoSummary | undefined,
  requireInference = true,
): Promise<{ sourceInstallationId: number; sourceOrgId: number; githubRepoId: number } | null> {
  if (!installationId || !repo) return null;
  const db = getDb();
  const installation = (
    await db
      .select({
        id: schema.installations.id,
        orgId: schema.installations.orgId,
        suspended: schema.installations.suspended,
      })
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, installationId))
      .limit(1)
  )[0];
  if (!installation || installation.suspended || installation.orgId === null) return null;
  // Defense in depth: require the repo row to belong to the claimed
  // installation, matching the worker path (review.ts / respond.ts both join
  // the repo via installationId). Without the join, a signature-valid payload
  // claiming installation A plus a repo row owned by installation B would pass
  // the enabled check; here we reject that mismatch at the webhook gate rather
  // than relying solely on GitHub's downstream token scoping.
  const repoRow = await upsertRepository(installation.id, repo, "github_pull_request");
  if (!repoRow?.enabled) return null;
  const allowed = !requireInference || (
    await canProcessRepositoryInference(db, {
      orgId: installation.orgId,
      repositoryPrivate: repo.private,
    })
  ).allowed;
  return allowed ? {
    sourceInstallationId: installation.id,
    sourceOrgId: installation.orgId,
    githubRepoId: repo.id,
  } : null;
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

// Respond jobs inherit delivery-id dedupe from the durable webhook inbox. A
// completed issue_comment/issues delivery is acknowledged without dispatch.
async function enqueueRespond(
  payload: RespondJobPayload,
  triggerFollowupDrain: boolean,
): Promise<"admitted" | "duplicate" | "rate_limited"> {
  const cap = respondHourlyCap();
  const admitted = await enqueueRespondJobWithinHourlyCap(getPool(), payload, cap);
  if (admitted.rateLimited) {
    console.warn(
      `respond job skipped: installation ${payload.installationId} exceeded ${cap} respond jobs/hour`,
    );
    return "rate_limited";
  }
  if (admitted.id === null) {
    console.log(`respond job skipped: delivery ${payload.sourceDeliveryId} already enqueued`);
    return "duplicate";
  }
  if (triggerFollowupDrain) triggerQueueDrain("respond");
  return "admitted";
}

async function enqueueConversationReaction(
  payload: CommentEventPayload,
  sourceDeliveryId: string,
  authority: { sourceInstallationId: number; sourceOrgId: number; githubRepoId: number },
  commentKind: "issue_comment" | "pull_request_review_comment",
  content: "+1" | "eyes",
): Promise<void> {
  const installationId = payload.installation?.id;
  const repo = payload.repository;
  const commentId = payload.comment?.id;
  if (
    !installationId ||
    !repo ||
    !Number.isSafeInteger(commentId) ||
    commentId === undefined ||
    commentId <= 0
  ) return;
  await enqueueGithubReactionJobOnce(getPool(), {
    installationId,
    ...authority,
    repoFullName: repo.full_name,
    commentId,
    commentKind,
    content,
    sourceDeliveryId,
  });
}

async function handleIssueComment(
  payload: CommentEventPayload,
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
): Promise<void> {
  if (payload.action !== "created") return;
  const body = payload.comment?.body;
  if (
    await handleFindingDecisionCommand(
      payload,
      sourceDeliveryId,
      "issue_comment",
      triggerFollowupDrain,
    )
  ) return;
  if (
    typeof body !== "string" ||
    !isAcceptableConversationRequest(body) ||
    !mentionsPostil(body) ||
    isBot(payload.comment?.user) ||
    isBot(payload.sender)
  ) return;
  if (!mayTriggerRespond(payload.comment?.author_association)) return;
  if (!payload.issue || !payload.repository) return;
  const authority = await enabledRepoForMention(payload.installation?.id, payload.repository);
  if (!authority) return;
  if (isGratitudeOnly(body)) {
    await enqueueConversationReaction(
      payload,
      sourceDeliveryId,
      authority,
      "issue_comment",
      "+1",
    );
    if (triggerFollowupDrain) triggerQueueDrain("conversation-gratitude");
    return;
  }
  if (isPostilReviewCommand(body)) {
    if (payload.issue.pull_request != null) {
      await enqueueMentionReview(
        payload,
        payload.issue.number,
        sourceDeliveryId,
        "issue_comment",
        triggerFollowupDrain,
      );
    } else {
      await queueWebhookComment(
        payload,
        "Review commands only work on pull requests.",
        sourceDeliveryId,
        triggerFollowupDrain,
      );
    }
    return;
  }
  const admission = await enqueueRespond({
    installationId: payload.installation!.id,
    ...authority,
    repoFullName: payload.repository.full_name,
    repositoryPrivate: payload.repository.private,
    number: payload.issue.number,
    // GitHub sends issue_comment for PR conversation comments too; the
    // pull_request marker distinguishes them.
    isPr: payload.issue.pull_request != null,
    ...(payload.issue.pull_request != null
      ? {
          sourceHeadSha: (
            await getPullRequestReviewContext(
              await getInstallationToken(payload.installation!.id),
              payload.repository.full_name,
              payload.issue.number,
            )
          ).headSha,
        }
      : {}),
    comment: body,
    sourceDeliveryId,
    trigger: respondTrigger(payload, sourceDeliveryId, "issue_comment"),
  }, false);
  if (admission === "rate_limited") return;
  await enqueueConversationReaction(
    payload,
    sourceDeliveryId,
    authority,
    "issue_comment",
    "eyes",
  );
  if (triggerFollowupDrain) triggerQueueDrain("conversation-request-admitted");
}

interface FindingPublicationBinding {
  findingId: string;
  githubCommentId: string;
  reviewId: number;
  headSha: string;
}

interface FindingPublicationBindingWithState extends FindingPublicationBinding {
  currentState: string;
}

const REVIEW_THREAD_CONVERGENCE_WINDOW_MS = 60_000;

async function loadFindingPublicationBinding(
  db: Database,
  installationId: number,
  githubRepoId: number,
  prNumber: number,
  commentIds: number[],
): Promise<FindingPublicationBinding | null> {
  const ids = [...new Set(commentIds)]
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 1_000)
    .map(String);
  if (ids.length === 0) return null;
  const rows = await db
    .select({
      findingId: schema.findingPublications.findingId,
      githubCommentId: schema.findingPublications.githubCommentId,
      reviewId: schema.reviews.id,
      headSha: schema.reviews.headSha,
    })
    .from(schema.findingPublications)
    .innerJoin(
      schema.reviews,
      eq(schema.reviews.id, schema.findingPublications.reviewId),
    )
    .innerJoin(
      schema.repositories,
      eq(schema.repositories.id, schema.reviews.repositoryId),
    )
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(
      and(
        eq(schema.installations.githubInstallationId, installationId),
        eq(schema.repositories.githubRepoId, githubRepoId),
        eq(schema.reviews.prNumber, prNumber),
        eq(schema.findingPublications.stableIdentity, true),
        inArray(schema.findingPublications.githubCommentId, ids),
      ),
    )
    .orderBy(
      desc(schema.reviews.finishedAt),
      desc(schema.reviews.id),
      desc(schema.findingPublications.id),
    )
    .limit(1_001);
  if (rows.length > 1_000) {
    throw new Error("finding publication reply lookup exceeded its identity bound");
  }
  const row = resolveFindingPublicationBinding(rows);
  return row?.githubCommentId ? { ...row, githubCommentId: row.githubCommentId } : null;
}

async function loadLatestFindingPublicationBindings(
  db: Database,
  installationId: number,
  githubRepoId: number,
  prNumber: number,
): Promise<FindingPublicationBindingWithState[]> {
  const review = await loadLatestCompletedReviewForPr(
    db,
    installationId,
    githubRepoId,
    prNumber,
  );
  if (!review?.envelope) return [];
  const findingIds = [...new Set([
    ...review.envelope.findings,
    ...review.envelope.resolved,
  ].flatMap((finding) => finding.id ? [finding.id] : []))];
  if (findingIds.length === 0) return [];
  if (findingIds.length > 1_000) {
    throw new Error("finding publication reconciliation exceeded its identity bound");
  }
  const rows = await db
    .selectDistinctOn([schema.findingPublications.findingId], {
      findingId: schema.findingPublications.findingId,
      githubCommentId: schema.findingPublications.githubCommentId,
      currentState: schema.findingPublications.currentState,
    })
    .from(schema.findingPublications)
    .innerJoin(
      schema.reviews,
      eq(schema.reviews.id, schema.findingPublications.reviewId),
    )
    .where(
      and(
        eq(schema.reviews.repositoryId, review.repositoryId),
        eq(schema.reviews.prNumber, prNumber),
        eq(schema.findingPublications.stableIdentity, true),
        isNotNull(schema.findingPublications.githubCommentId),
        inArray(schema.findingPublications.findingId, findingIds),
      ),
    )
    .orderBy(
      schema.findingPublications.findingId,
      desc(schema.reviews.finishedAt),
      desc(schema.reviews.id),
      desc(schema.findingPublications.id),
    );
  const bindings = rows.flatMap((row) => row.githubCommentId
    ? [{
        ...row,
        githubCommentId: row.githubCommentId,
        reviewId: review.id,
        headSha: review.headSha,
      }]
    : []);
  assertOneFindingPerGithubComment(bindings);
  return bindings;
}

function sameGithubActor(
  sender: GithubUser | undefined,
  author: GithubUser | undefined,
): GithubUser | null {
  if (
    typeof sender?.id !== "number" ||
    !Number.isSafeInteger(sender.id) ||
    sender.id <= 0 ||
    typeof sender.login !== "string" ||
    !sender.login ||
    sender.id !== author?.id ||
    sender.login.toLowerCase() !== author.login?.toLowerCase()
  ) return null;
  return sender;
}

async function enqueueFindingReconciliationReview(input: {
  installationId: number;
  repository: RepoSummary;
  prNumber: number;
  binding: FindingPublicationBinding;
  actor?: GithubUser;
  sourceDeliveryId: string;
  webhookEvent: "pull_request_review_comment" | "pull_request_review_thread";
  webhookAction: string;
  sourceCommentId?: number;
  sourceUrl?: string;
  recordActor?: boolean;
  triggerFollowupDrain: boolean;
}): Promise<boolean> {
  const authority = await enabledRepoForMention(
    input.installationId,
    input.repository,
  );
  if (!authority) return false;
  const token = await getInstallationToken(input.installationId);
  if (
    !await hasGitHubRepositoryWriteAuthority(
      token,
      input.repository.full_name,
      input.actor,
    )
  ) return false;
  const context = await getPullRequestReviewContext(
    token,
    input.repository.full_name,
    input.prNumber,
  );
  if (
    !context.open ||
    context.merged ||
    context.draft ||
    context.headSha !== input.binding.headSha
  ) return false;
  const latest = await loadLatestCompletedReviewForPr(
    getDb(),
    input.installationId,
    input.repository.id,
    input.prNumber,
  );
  if (!latest || latest.headSha !== context.headSha || !latest.envelope) return false;
  const activeFinding = [
    ...latest.envelope.findings,
    ...latest.envelope.resolved,
  ].find(
    (finding) => finding.id === input.binding.findingId,
  );
  if (!activeFinding || activeFinding.kind === "humanEscalation") return false;

  const queued = await enqueueReviewJob({
    installationId: input.installationId,
    ...authority,
    repoFullName: input.repository.full_name,
    repositoryPrivate: input.repository.private,
    prNumber: input.prNumber,
    ...(context.authorGithubId !== undefined
      ? { authorGithubId: context.authorGithubId }
      : {}),
    ...(context.authorLogin ? { authorLogin: context.authorLogin } : {}),
    headSha: context.headSha,
    baseSha: context.baseSha,
    expectedPullRequestUpdatedAt: context.updatedAt,
    sourceDeliveryId: input.sourceDeliveryId,
    forceFullReview: true,
    trigger: {
      source: "finding_reconciliation",
      webhookDeliveryId: input.sourceDeliveryId,
      webhookEvent: input.webhookEvent,
      webhookAction: input.webhookAction,
      ...(input.sourceCommentId !== undefined
        ? { sourceCommentId: input.sourceCommentId }
        : {}),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.recordActor !== false && typeof input.actor?.id === "number"
        ? { requestedByGithubId: input.actor.id }
        : {}),
      ...(input.recordActor !== false && input.actor?.login
        ? { requestedByLogin: input.actor.login }
        : {}),
    },
  }, false);
  if (queued !== null && input.triggerFollowupDrain) {
    triggerQueueDrain("finding-reconciliation-admitted");
  }
  return true;
}

async function handleReviewThread(
  payload: ReviewThreadEventPayload,
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
): Promise<void> {
  if (payload.action !== "resolved") return;
  const installationId = payload.installation?.id;
  const repository = payload.repository;
  const prNumber = payload.pull_request?.number;
  const threadUpdatedAt = payload.thread?.updated_at;
  const threadUpdatedAtMs = typeof threadUpdatedAt === "string"
    ? Date.parse(threadUpdatedAt)
    : Number.NaN;
  const observedAtMs = Date.now();
  if (
    !installationId ||
    !repository ||
    !Number.isSafeInteger(prNumber) ||
    !prNumber ||
    prNumber <= 0 ||
    !payload.thread ||
    (threadUpdatedAt !== null && !Number.isFinite(threadUpdatedAtMs)) ||
    threadUpdatedAtMs > observedAtMs + REVIEW_THREAD_CONVERGENCE_WINDOW_MS ||
    isBot(payload.sender)
  ) return;
  const bindings = await loadLatestFindingPublicationBindings(
    getDb(),
    installationId,
    repository.id,
    prNumber,
  );
  if (bindings.length === 0) return;
  const token = await getInstallationToken(installationId);
  const context = await getPullRequestReviewContext(
    token,
    repository.full_name,
    prNumber,
  );
  const authorGithubId = context.authorGithubId;
  if (
    typeof authorGithubId !== "number" ||
    !Number.isSafeInteger(authorGithubId) ||
    authorGithubId <= 0
  ) return;
  const observations = await observeGitHubReviewThreads(
    token,
    repository.full_name,
    prNumber,
    bindings.map((binding) => binding.githubCommentId),
    authorGithubId,
  );
  const observationsByComment = new Map(
    observations.map((observation) => [observation.githubCommentId, observation]),
  );
  const changed = bindings.filter((binding) => {
    const observation = observationsByComment.get(binding.githubCommentId);
    return observation?.state === "resolved" && binding.currentState !== "resolved";
  });
  const deliveryReceivedAt = Number.isFinite(threadUpdatedAtMs)
    ? undefined
    : (
        await getDb()
          .select({ receivedAt: schema.webhookDeliveries.receivedAt })
          .from(schema.webhookDeliveries)
          .where(eq(schema.webhookDeliveries.deliveryId, sourceDeliveryId))
          .limit(1)
      )[0]?.receivedAt;
  const eventMayStillConverge = Number.isFinite(threadUpdatedAtMs)
    ? threadUpdatedAtMs > observedAtMs - REVIEW_THREAD_CONVERGENCE_WINDOW_MS
    : deliveryReceivedAt === undefined ||
      deliveryReceivedAt.getTime() > observedAtMs - REVIEW_THREAD_CONVERGENCE_WINDOW_MS;
  if (eventMayStillConverge) {
    throw new Error("GitHub review thread state has not converged");
  }
  if (changed.length === 0) {
    await applyPublicationThreadObservations(getDb(), observations);
    return;
  }
  await recordPublicationThreadObservations(getDb(), {
    sourceDeliveryId,
    bindings: changed,
    observations,
  });
  const authorizedBindings = changed.filter((binding) =>
    observationsByComment.get(binding.githubCommentId)?.resolutionAuthorized === true &&
    typeof observationsByComment.get(binding.githubCommentId)?.resolvedByGithubId === "number" &&
    typeof observationsByComment.get(binding.githubCommentId)?.resolvedByLogin === "string"
  );
  const authorized = authorizedBindings[0];
  if (!authorized) return;
  const authorizedObservation = observationsByComment.get(authorized.githubCommentId)!;
  const queued = await enqueueFindingReconciliationReview({
    installationId,
    repository,
    prNumber,
    binding: authorized,
    actor: {
      id: authorizedObservation.resolvedByGithubId,
      login: authorizedObservation.resolvedByLogin,
      type: "User",
    },
    sourceDeliveryId,
    webhookEvent: "pull_request_review_thread",
    webhookAction: payload.action,
    recordActor: false,
    triggerFollowupDrain,
  });
  if (!queued) return;
  const authorizedCommentIds = new Set(
    authorizedBindings.map((binding) => binding.githubCommentId),
  );
  await applyPublicationThreadObservations(
    getDb(),
    observations.filter((observation) =>
      authorizedCommentIds.has(observation.githubCommentId)
    ),
  );
}

async function handleReviewComment(
  payload: CommentEventPayload,
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
): Promise<void> {
  if (payload.action === "deleted" && typeof payload.comment?.id === "number") {
    await applyPublicationThreadObservations(getDb(), [
      { githubCommentId: String(payload.comment.id), state: "deleted" },
    ]);
    return;
  }
  if (payload.action !== "created") return;
  const body = payload.comment?.body;
  if (
    await handleFindingDecisionCommand(
      payload,
      sourceDeliveryId,
      "pull_request_review_comment",
      triggerFollowupDrain,
    )
  ) return;
  const inReplyToId = payload.comment?.in_reply_to_id;
  const replyActor = sameGithubActor(payload.sender, payload.comment?.user);
  if (
    typeof body === "string" &&
    isAcceptableConversationRequest(body) &&
    !isClarificationRequest(body) &&
    !isGratitudeOnly(body) &&
    Number.isSafeInteger(inReplyToId) &&
    inReplyToId !== undefined &&
    inReplyToId > 0 &&
    replyActor &&
    !isBot(replyActor) &&
    mayTriggerRespond(payload.comment?.author_association) &&
    payload.pull_request &&
    payload.repository &&
    payload.installation?.id
  ) {
    const binding = await loadFindingPublicationBinding(
      getDb(),
      payload.installation.id,
      payload.repository.id,
      payload.pull_request.number,
      [inReplyToId],
    );
    if (binding) {
      const queued = await enqueueFindingReconciliationReview({
        installationId: payload.installation.id,
        repository: payload.repository,
        prNumber: payload.pull_request.number,
        binding,
        actor: replyActor,
        sourceDeliveryId,
        webhookEvent: "pull_request_review_comment",
        webhookAction: "created",
        sourceCommentId: Number(binding.githubCommentId),
        ...(payload.comment?.html_url
          ? { sourceUrl: payload.comment.html_url }
          : {}),
        triggerFollowupDrain: false,
      });
      if (queued) {
        const authority = await enabledRepoForMention(
          payload.installation.id,
          payload.repository,
        );
        if (authority) {
          await enqueueConversationReaction(
            payload,
            sourceDeliveryId,
            authority,
            "pull_request_review_comment",
            "eyes",
          );
        }
        if (triggerFollowupDrain) {
          triggerQueueDrain("finding-evidence-admitted");
        }
      }
      return;
    }
  }
  if (typeof body !== "string" || !isAcceptableConversationRequest(body)) return;
  const explicitMention = mentionsPostil(body);
  if (
    (!explicitMention &&
      (!Number.isSafeInteger(inReplyToId) || inReplyToId === undefined || inReplyToId <= 0)) ||
    isBot(payload.comment?.user) ||
    isBot(payload.sender)
  ) return;
  if (!mayTriggerRespond(payload.comment?.author_association)) return;
  if (!payload.pull_request || !payload.repository) return;
  const authority = await enabledRepoForMention(payload.installation?.id, payload.repository);
  if (!authority) return;
  if (explicitMention && isPostilReviewCommand(body)) {
    await enqueueMentionReview(
      payload,
      payload.pull_request.number,
      sourceDeliveryId,
      "pull_request_review_comment",
      triggerFollowupDrain,
    );
    return;
  }
  const token = await getInstallationToken(payload.installation!.id);
  let threadContext: string | undefined;
  if (!explicitMention) {
    const root = await getPullRequestReviewComment(
      token,
      payload.repository.full_name,
      inReplyToId!,
    );
    if (!isPostilBotLogin(root.userLogin)) return;
    if (isGratitudeOnly(body!)) {
      await enqueueConversationReaction(
        payload,
        sourceDeliveryId,
        authority,
        "pull_request_review_comment",
        "+1",
      );
      if (triggerFollowupDrain) triggerQueueDrain("conversation-gratitude");
      return;
    }
    if (!isClarificationRequest(body!)) return;
    threadContext = boundedThreadContext(root.body);
  } else if (isGratitudeOnly(body!)) {
    await enqueueConversationReaction(
      payload,
      sourceDeliveryId,
      authority,
      "pull_request_review_comment",
      "+1",
    );
    if (triggerFollowupDrain) triggerQueueDrain("conversation-gratitude");
    return;
  }
  // Review comments anchor to a file/line; without it the bot answers blind
  // to which code the question is about.
  const anchor =
    payload.comment?.path != null
      ? `${payload.comment.path}${payload.comment.line != null ? `:${payload.comment.line}` : ""}`
      : undefined;
  const sourceCommentId = payload.comment?.id;
  if (
    !Number.isSafeInteger(sourceCommentId) ||
    sourceCommentId === undefined ||
    sourceCommentId <= 0
  ) return;
  const admission = await enqueueRespond({
    installationId: payload.installation!.id,
    ...authority,
    repoFullName: payload.repository.full_name,
    repositoryPrivate: payload.repository.private,
    number: payload.pull_request.number,
    isPr: true,
    sourceHeadSha: (
      await getPullRequestReviewContext(
        token,
        payload.repository.full_name,
        payload.pull_request.number,
      )
    ).headSha,
    comment: body!,
    commentAnchor: anchor,
    ...(threadContext ? { threadContext } : {}),
    replyToReviewCommentId: inReplyToId ?? sourceCommentId,
    sourceDeliveryId,
    trigger: respondTrigger(payload, sourceDeliveryId, "pull_request_review_comment"),
  }, false);
  if (admission === "rate_limited") return;
  await enqueueConversationReaction(
    payload,
    sourceDeliveryId,
    authority,
    "pull_request_review_comment",
    "eyes",
  );
  if (triggerFollowupDrain) triggerQueueDrain("conversation-request-admitted");
}

function respondTrigger(
  payload: CommentEventPayload,
  sourceDeliveryId: string,
  webhookEvent: "issue_comment" | "pull_request_review_comment",
): NonNullable<RespondJobPayload["trigger"]> {
  return {
    source: "github_mention",
    webhookDeliveryId: sourceDeliveryId,
    webhookEvent,
    webhookAction: "created",
    ...(typeof payload.comment?.id === "number"
      ? { sourceCommentId: payload.comment.id }
      : {}),
    ...(payload.comment?.html_url ? { sourceUrl: payload.comment.html_url } : {}),
    ...(typeof payload.comment?.user?.id === "number"
      ? { requestedByGithubId: payload.comment.user.id }
      : {}),
    ...(payload.comment?.user?.login
      ? { requestedByLogin: payload.comment.user.login }
      : {}),
  };
}

async function enqueueMentionReview(
  payload: CommentEventPayload,
  prNumber: number,
  sourceDeliveryId: string,
  webhookEvent: "issue_comment" | "pull_request_review_comment",
  triggerFollowupDrain: boolean,
): Promise<void> {
  const installationId = payload.installation?.id;
  const repo = payload.repository;
  const commentId = payload.comment?.id;
  if (
    !installationId ||
    !repo ||
    !Number.isSafeInteger(commentId) ||
    commentId === undefined ||
    commentId <= 0
  ) return;
  const token = await getInstallationToken(installationId);
  const context = await getPullRequestReviewContext(token, repo.full_name, prNumber);
  if (!context.open || context.merged || context.draft) return;
  const authority = await enabledRepoForMention(installationId, repo);
  if (!authority) return;
  // Admit both durable jobs before waking a web drain so the short reaction
  // can be claimed ahead of the model-backed review.
  await enqueueReviewJob({
    installationId,
    ...authority,
    repoFullName: repo.full_name,
    repositoryPrivate: repo.private,
    prNumber,
    ...(context.authorGithubId !== undefined
      ? { authorGithubId: context.authorGithubId }
      : {}),
    ...(context.authorLogin ? { authorLogin: context.authorLogin } : {}),
    headSha: context.headSha,
    baseSha: context.baseSha,
    expectedPullRequestUpdatedAt: context.updatedAt,
    sourceDeliveryId,
    forceFullReview: true,
    trigger: {
      source: "requested_review",
      webhookDeliveryId: sourceDeliveryId,
      webhookEvent,
      webhookAction: "created",
      ...(typeof payload.comment?.id === "number"
        ? { sourceCommentId: payload.comment.id }
        : {}),
      ...(payload.comment?.html_url ? { sourceUrl: payload.comment.html_url } : {}),
      ...(typeof payload.comment?.user?.id === "number"
        ? { requestedByGithubId: payload.comment.user.id }
        : {}),
      ...(payload.comment?.user?.login
        ? { requestedByLogin: payload.comment.user.login }
        : {}),
    },
  }, false);
  await enqueueGithubReactionJobOnce(getPool(), {
    installationId,
    ...authority,
    repoFullName: repo.full_name,
    commentId,
    commentKind: webhookEvent,
    content: "eyes",
    sourceDeliveryId,
  });
  if (triggerFollowupDrain) {
    triggerQueueDrain("requested-review-admitted");
  }
}

async function handleFindingDecisionCommand(
  payload: CommentEventPayload,
  sourceDeliveryId: string,
  commentKind: "issue_comment" | "pull_request_review_comment",
  triggerFollowupDrain: boolean,
): Promise<boolean> {
  const approvalCommand = parsePostilApproveCommand(payload.comment?.body);
  const dismissalCommand = parsePostilDismissCommand(payload.comment?.body);
  const command = dismissalCommand ?? approvalCommand;
  if (!command) return false;
  const verb = dismissalCommand ? "dismiss" : "approve";
  const decisionLabel = verb === "dismiss" ? "Dismissal" : "Approval";

  const repo = payload.repository;
  const installationId = payload.installation?.id;
  const prNumber = payload.issue?.pull_request
    ? payload.issue.number
    : payload.pull_request?.number;
  const githubCommentId = payload.comment?.id;
  if (
    !repo ||
    !installationId ||
    !prNumber ||
    typeof githubCommentId !== "number" ||
    !Number.isSafeInteger(githubCommentId) ||
    githubCommentId <= 0 ||
    !sourceDeliveryId.trim() ||
    sourceDeliveryId.length > 200
  ) {
    await queueWebhookComment(
      payload,
      `${decisionLabel} rejected: the GitHub event lacks a complete pull request or comment identity.`,
      sourceDeliveryId,
      triggerFollowupDrain,
    );
    return true;
  }
  const publicationAuthority = await enabledRepoForMention(
    installationId,
    repo,
    false,
  );
  if (!publicationAuthority) return true;

  if (!command.ok) {
    await queueWebhookComment(payload, command.error, sourceDeliveryId, triggerFollowupDrain);
    return true;
  }
  const dismissal = dismissalCommand?.ok ? dismissalCommand : null;

  const token = await getInstallationToken(installationId);
  const db = getDb();
  const review = await loadLatestCompletedReviewForPr(db, installationId, repo.id, prNumber);
  if (!review) {
    await queueWebhookComment(
      payload,
      "No completed Postil review was found for this pull request.",
      sourceDeliveryId,
      triggerFollowupDrain,
    );
    return true;
  }

  if (await hasInFlightReviewForPr(db, review)) {
    await queueWebhookComment(
      payload,
      `${decisionLabel} rejected: a review is in progress; re-issue after it completes.`,
      sourceDeliveryId,
      triggerFollowupDrain,
    );
    return true;
  }

  let requestedFindingId = command.ok ? command.findingId : null;
  if (verb === "dismiss" && command.ok && !requestedFindingId) {
    const replyTo = payload.comment?.in_reply_to_id;
    if (commentKind !== "pull_request_review_comment" || !Number.isSafeInteger(replyTo) || !replyTo || replyTo <= 0) {
      await queueWebhookComment(
        payload,
        "Dismissal rejected: include a finding id, or reply directly to the finding comment.",
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    const publication = (await db.select({ findingId: schema.findingPublications.findingId })
      .from(schema.findingPublications)
      .where(and(eq(schema.findingPublications.reviewId, review.id), eq(schema.findingPublications.githubCommentId, String(replyTo))))
      .limit(1))[0];
    if (!publication) {
      await queueWebhookComment(
        payload,
        "Dismissal rejected: the replied-to comment is not a finding from this review.",
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    requestedFindingId = publication.findingId;
  }

  const currentHeadSha = await getPullRequestHeadSha(token, repo.full_name, prNumber);
  if (currentHeadSha !== review.headSha) {
    await queueWebhookComment(
      payload,
      `${decisionLabel} rejected: the pull request head is ${currentHeadSha.slice(0, 12)}, but the latest completed review is for ${review.headSha.slice(0, 12)}.`,
      sourceDeliveryId,
      triggerFollowupDrain,
    );
    return true;
  }

  if (await hasNewerCompletedReviewForHead(db, review)) {
    await queueWebhookComment(
      payload,
      `${decisionLabel} rejected: a newer completed review exists for this commit.`,
      sourceDeliveryId,
      triggerFollowupDrain,
    );
    return true;
  }

  const actor = await loadLiveApprovalActor(
    review,
    payload.comment?.user,
    repo.full_name,
    token,
  );
  if (!actor) {
    await queueWebhookComment(
      payload,
      `${decisionLabel} rejected: GitHub could not verify this account as an active organization member.`,
      sourceDeliveryId,
      triggerFollowupDrain,
    );
    return true;
  }
  if (actor.role !== "admin") {
    await queueWebhookComment(
      payload,
      `${decisionLabel} rejected: this decision requires an organization admin.`,
      sourceDeliveryId,
      triggerFollowupDrain,
    );
    return true;
  }
  let authorGithubId = review.authorGithubId ?? null;
  let effectiveFailing: boolean | null = null;
  try {
    if (verb === "dismiss" && authorGithubId === null) {
      authorGithubId = (
        await getPullRequestReviewContext(token, repo.full_name, prNumber)
      ).authorGithubId ?? null;
    }
    const state = await getReviewApprovalState(db, review);
    const resolution = verb === "dismiss"
      ? resolveDismissibleFindingId(state, requestedFindingId!)
      : resolveApprovableFindingId(state, requestedFindingId!);
    if (!resolution.ok && resolution.reason === "ambiguous") {
      await queueWebhookComment(
        payload,
        `${verb === "dismiss" ? "Dismissal" : "Approval"} rejected: finding id prefix ${requestedFindingId} matches ${resolution.matches.length} blocking findings. Use a longer prefix or the full id.`,
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    const findingId = resolution.ok ? resolution.findingId : requestedFindingId!;
    const finding = verb === "dismiss"
      ? findDismissibleFindingState(state, findingId)
      : findKindBlockingState(state, findingId);
    const acknowledgingAuthorDismissal = Boolean(
      verb === "approve" && finding?.awaitingIndependentAck,
    );
    if (
      !finding ||
      (verb === "dismiss"
        ? finding.activeDismissal || finding.activeApproval
        : !finding.blocking ||
          finding.activeApproval ||
          (!acknowledgingAuthorDismissal &&
            (finding.activeDismissal || finding.latestApproval?.revokedAt)))
    ) {
      await queueWebhookComment(
        payload,
        verb === "dismiss"
          ? "Dismissal rejected: that finding is absent, operational, already dismissed, or has an active approval."
          : "Approval rejected: that finding is absent, already approved, revoked, or no longer kind-blocking.",
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    if (
      acknowledgingAuthorDismissal &&
      finding.activeDismissal?.actorGithubId === actor.githubId
    ) {
      await queueWebhookComment(
        payload,
        "Approval rejected: the pull request author's dismissal requires acknowledgement from a different organization admin.",
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    if (verb === "approve" && finding.severityBlocking && !acknowledgingAuthorDismissal) {
      await queueWebhookComment(
        payload,
        "Approval rejected: this finding is also severity-blocking, and approvals only clear kind-based blocks.",
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }

    await db.transaction(async (tx) => {
      await lockActiveReviewState(tx, review);
      await lockReviewApprovalState(tx, review.id);
      if (await hasNewerReviewForPr(tx, review)) {
        throw new Error("a newer review exists");
      }
      if (await hasInFlightReviewForPr(tx, review)) {
        throw new Error("a review is in progress");
      }
      const lockedState = await getReviewApprovalState(tx, review);
      const lockedFinding = verb === "dismiss"
        ? findDismissibleFindingState(lockedState, findingId)
        : findKindBlockingState(lockedState, findingId);
      const lockedAcknowledgement = Boolean(
        verb === "approve" && lockedFinding?.awaitingIndependentAck,
      );
      if (
        !lockedFinding ||
        (verb === "dismiss"
          ? Boolean(lockedFinding.activeDismissal || lockedFinding.activeApproval)
          : !lockedFinding.blocking ||
            lockedFinding.activeApproval ||
            (!lockedAcknowledgement &&
              (lockedFinding.activeDismissal ||
                lockedFinding.latestApproval?.revokedAt ||
                lockedFinding.severityBlocking)))
      ) {
        throw new Error("the finding changed while the approval was being recorded");
      }
      if (
        lockedAcknowledgement &&
        lockedFinding.activeDismissal?.actorGithubId === actor.githubId
      ) {
        throw new Error("the author's dismissal requires an independent admin");
      }
      if (lockedAcknowledgement) {
        const revokedDismissalId = await revokeFindingApproval(
          tx,
          review.id,
          findingId,
          actor.userId,
          "dismiss",
        );
        if (!revokedDismissalId) {
          throw new Error("the finding changed while the approval was being recorded");
        }
      }
      await insertFindingApproval(tx, {
        reviewId: review.id,
        findingId,
        actor,
        rationale: command.rationale,
        verb,
        ...(verb === "dismiss" ? {
          reasonTag: dismissal!.reasonTag,
          authorSelfDismissal: authorGithubId === Number(actor.githubId),
          finding: lockedFinding.finding,
          findingModel: review.envelope!.modelUsed,
        } : {}),
        source: "github",
        sourceCommentId: null,
        sourceUrl: payload.comment?.html_url ?? null,
        binding: {
          orgId: review.orgId,
          repositoryId: review.repositoryId,
          githubInstallationId: review.githubInstallationId,
          githubRepoId: review.githubRepoId,
          prNumber: review.prNumber,
          headSha: review.headSha,
        },
        githubSource: {
          webhookDeliveryId: sourceDeliveryId,
          githubCommentId,
          commentKind,
        },
      });
      const nextState = await getReviewApprovalState(tx, review);
      effectiveFailing = nextState.effectiveGate.failing;
      const gateEnabled = review.orgId
        ? await lockOrganizationGateMode(tx, review.orgId)
        : false;
      await updateStoredEffectiveGate(tx, review.id, effectiveFailing, gateEnabled);
      await enqueueGateStateSync(tx, review);
      await enqueueWebhookComment(tx, {
        installationId,
        ...publicationAuthority,
        repoFullName: repo.full_name,
        number: prNumber,
        isPr: true,
        sourceHeadSha: review.headSha,
        sourceDeliveryId,
        body: verb === "dismiss"
          ? authorGithubId === Number(actor.githubId) &&
            (lockedFinding.finding.kind === "risk" ||
              lockedFinding.finding.kind === "humanEscalation")
            ? `Dismissal recorded by @${actor.login} for finding ${findingId} on commit ${review.headSha}: ${dismissal!.reasonTag}. This finding is awaiting independent admin acknowledgement, so it remains blocking. A different organization admin must acknowledge the pull request author's dismissal; leave this thread open.`
            : `Dismissal recorded by @${actor.login} for finding ${findingId} on commit ${review.headSha}: ${dismissal!.reasonTag}. ${authorGithubId === Number(actor.githubId) ? "The pull request author dismissed this finding. " : ""}The gate update is queued${effectiveFailing ? "; other blockers remain" : ""}. You may now resolve this thread.`
          : lockedAcknowledgement
            ? `Independent acknowledgement recorded by @${actor.login} for the pull request author's dismissal of finding ${findingId} on commit ${review.headSha}. The gate update is queued${effectiveFailing ? "; other blockers remain" : ""}.`
            : `Approval recorded by @${actor.login} for finding ${findingId} on commit ${review.headSha}. The gate update is queued${effectiveFailing ? "; other blockers remain" : ""}.`,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "a review is in progress") {
      await queueWebhookComment(
        payload,
        `${decisionLabel} rejected: a review is in progress; re-issue after it completes.`,
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    if (err instanceof Error && err.message === "a newer review exists") {
      await queueWebhookComment(
        payload,
        `${decisionLabel} rejected: a newer review exists for this pull request.`,
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    if (
      err instanceof Error &&
      err.message === "the author's dismissal requires an independent admin"
    ) {
      await queueWebhookComment(
        payload,
        "Approval rejected: the pull request author's dismissal requires acknowledgement from a different organization admin.",
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    if (isUniqueConstraintError(err)) {
      await queueWebhookComment(
        payload,
        verb === "dismiss"
          ? "Dismissal rejected: this finding already has an active dismissal."
          : "Approval rejected: this finding already has an active approval.",
        sourceDeliveryId,
        triggerFollowupDrain,
      );
      return true;
    }
    console.error(`${verb} command failed: ${redactSecrets(err)}`);
    await queueWebhookComment(
      payload,
      `${verb === "dismiss" ? "Dismissal" : "Approval"} could not be recorded. Try again or open the Postil run for details.`,
      sourceDeliveryId,
      triggerFollowupDrain,
    );
    return true;
  }

  if (triggerFollowupDrain) {
    triggerQueueDrain("gate-state-sync");
    triggerQueueDrain("webhook-comment");
  }
  return true;
}

async function queueWebhookComment(
  payload: CommentEventPayload,
  body: string,
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
): Promise<void> {
  const repo = payload.repository;
  const installationId = payload.installation?.id;
  const number = payload.issue?.number ?? payload.pull_request?.number;
  if (!repo || !installationId || !number) return;
  const authority = await enabledRepoForMention(installationId, repo, false);
  if (!authority) return;
  const isPr = payload.issue?.pull_request != null || payload.pull_request != null;
  const sourceHeadSha = isPr
    ? (await getPullRequestReviewContext(
        await getInstallationToken(installationId),
        repo.full_name,
        number,
      )).headSha
    : undefined;
  const inserted = await enqueueWebhookComment(getDb(), {
    installationId,
    ...authority,
    repoFullName: repo.full_name,
    number,
    isPr,
    ...(sourceHeadSha ? { sourceHeadSha } : {}),
    body,
    sourceDeliveryId,
  });
  if (inserted && triggerFollowupDrain) triggerQueueDrain("webhook-comment");
}

async function enqueueWebhookComment(
  db: Database,
  payload: WebhookCommentJobPayload,
): Promise<boolean> {
  const inserted = await db
    .insert(schema.jobs)
    .values({
      kind: "webhook-comment",
      payload,
      maxAttempts: 2_147_483_647,
    })
    .onConflictDoNothing()
    .returning({ id: schema.jobs.id });
  return inserted.length > 0;
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

async function handleIssues(
  payload: IssuesEventPayload,
  sourceDeliveryId: string,
  triggerFollowupDrain: boolean,
): Promise<void> {
  // Only the opening of an issue that mentions the bot; edits/labels are noise.
  if (payload.action !== "opened") return;
  const body = payload.issue?.body;
  if (!mentionsPostil(body) || isBot(payload.sender)) return;
  if (!mayTriggerRespond(payload.issue?.author_association)) return;
  if (!payload.issue || !payload.repository) return;
  const authority = await enabledRepoForMention(
    payload.installation?.id,
    payload.repository,
  );
  if (!authority) return;
  await enqueueRespond({
    installationId: payload.installation!.id,
    sourceInstallationId: authority.sourceInstallationId,
    sourceOrgId: authority.sourceOrgId,
    githubRepoId: authority.githubRepoId,
    repoFullName: payload.repository.full_name,
    repositoryPrivate: payload.repository.private,
    number: payload.issue.number,
    isPr: false,
    comment: body!,
    sourceDeliveryId,
    trigger: {
      source: "github_mention",
      webhookDeliveryId: sourceDeliveryId,
      webhookEvent: "issues",
      webhookAction: "opened",
      ...(typeof payload.sender?.id === "number"
        ? { requestedByGithubId: payload.sender.id }
        : {}),
      ...(payload.sender?.login ? { requestedByLogin: payload.sender.login } : {}),
    },
  }, triggerFollowupDrain);
}
