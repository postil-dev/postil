import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { and, eq } from "drizzle-orm";

import { getDb, getPool, schema } from "@/lib/db";
import { hostedInferenceAvailable, optionalEnv } from "@/lib/env";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  deleteIssueComment,
  deletePullRequestReviewComment,
  findIssueCommentByMarker,
  findPullRequestReviewCommentByMarker,
  getPullRequestReviewContext,
  postIssueComment,
  postPullRequestReviewCommentReply,
} from "@/lib/github/checks";
import { materializeRepoConfig } from "@/lib/github/contents";
import { fetchRepositorySummary } from "@/lib/github/installation-sync";
import type {
  ExternalSideEffectLease,
  RespondDeliveryJobPayload,
  RespondFailureCommentJobPayload,
  RespondJobPayload,
  WebhookCommentJobPayload,
} from "@/lib/queue";
import { externalSideEffectLeaseActive } from "@/lib/queue";
import {
  canProcessRepositoryInference,
  providerModeMatchesRepositoryAccess,
} from "@/lib/private-repository-entitlement";
import {
  reconcileHostedRespondSpend,
  releaseHostedRespondSpend,
  reserveHostedRespondSpend,
} from "@/lib/hosted-usage-reservations";
import { redactAndTruncate, redactSecrets } from "@/lib/redact";
import { validateRespondPublication } from "@/lib/publication";
import { readRespondUsageReceipt } from "@/lib/respond-usage-receipt";
import {
  claimRespondDelivery,
  getRespondDelivery,
  markRespondCancelled,
  markRespondDelivered,
  prepareUnmeteredRespondDelivery,
  RESPOND_DELIVERY_REQUEST_TIMEOUT_MS,
  respondPublicationLeaseActive,
  respondDeliveryMarkerForDelivery,
  respondDeliveryMarkers,
} from "@/lib/respond-delivery";
import { buildCliEnv, resolveLlmConfig, runCli } from "./review";

/**
 * Run one interactive bot reply: an @postil mention on a PR or issue.
 *
 * Like the review job, the worker stays thin — mint a token, set the LLM
 * environment, and let the CLI fetch context, generate the answer, and post
 * the reply. Postil only reviews and answers; it never opens PRs or pushes.
 */
export async function runRespondJob(
  payload: RespondJobPayload,
  lease: ExternalSideEffectLease,
): Promise<void> {
  const jobId = lease.id;
  // A malformed row must fail loudly, not spawn the CLI with "undefined" argv.
  if (
    typeof payload.installationId !== "number" ||
    typeof payload.sourceInstallationId !== "number" ||
    typeof payload.sourceOrgId !== "number" ||
    typeof payload.githubRepoId !== "number" ||
    typeof payload.repoFullName !== "string" ||
    typeof payload.number !== "number" ||
    typeof payload.comment !== "string" ||
    payload.comment.trim() === "" ||
    (payload.threadContext !== undefined &&
      (typeof payload.threadContext !== "string" ||
        payload.threadContext.length > 4_000)) ||
    (payload.replyToReviewCommentId !== undefined &&
      (!Number.isSafeInteger(payload.replyToReviewCommentId) ||
        payload.replyToReviewCommentId <= 0 ||
        !payload.isPr))
  ) {
    throw new Error(`respond job payload malformed: ${JSON.stringify(Object.keys(payload))}`);
  }
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("respond job id is invalid");
  const db = getDb();

  const installation = (
    await db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, payload.installationId))
      .limit(1)
  )[0];
  if (
    !installation ||
    installation.suspended ||
    installation.id !== payload.sourceInstallationId ||
    installation.orgId !== payload.sourceOrgId
  ) {
    console.warn(`respond job skipped: installation ${payload.installationId} missing/suspended`);
    return;
  }

  const repository = (
    await db
      .select()
      .from(schema.repositories)
      .where(
        and(
          eq(schema.repositories.installationId, installation.id),
          eq(schema.repositories.githubRepoId, payload.githubRepoId),
        ),
      )
      .limit(1)
  )[0];
  if (!repository || !repository.enabled || repository.fullName !== payload.repoFullName) {
    console.warn(`respond job skipped: repository ${payload.repoFullName} missing or disabled`);
    return;
  }
  const signedOrStoredPrivate = repository.private || payload.repositoryPrivate === true;
  const repositoryAccess = await canProcessRepositoryInference(db, {
    orgId: installation.orgId,
    repositoryPrivate: signedOrStoredPrivate,
  });
  if (!repositoryAccess.allowed) {
    console.warn(`respond job skipped: private repository ${payload.repoFullName} requires billing`);
    return;
  }

  const llm = await resolveLlmConfig(installation.orgId);
  if (!providerModeMatchesRepositoryAccess(signedOrStoredPrivate, repositoryAccess, llm.byok)) {
    console.warn(
      `respond job skipped: private repository ${payload.repoFullName} provider mode does not match billing`,
    );
    return;
  }
  if (!llm.byok && !(await hostedInferenceAvailable(getPool()))) {
    console.warn("respond job skipped: managed hosted inference is unavailable");
    return;
  }

  const token = await getInstallationToken(payload.installationId);
  const currentRepository = await fetchRepositorySummary(token, payload.repoFullName);
  if (
    currentRepository.id !== payload.githubRepoId ||
    currentRepository.full_name !== payload.repoFullName
  ) {
    console.warn(`respond job skipped: repository identity changed for ${payload.repoFullName}`);
    return;
  }
  await db
    .update(schema.repositories)
    .set({ fullName: currentRepository.full_name, private: currentRepository.private })
    .where(eq(schema.repositories.id, repository.id));
  const currentAccess = await canProcessRepositoryInference(db, {
    orgId: installation.orgId,
    repositoryPrivate: currentRepository.private,
  });
  if (
    !currentAccess.allowed ||
    !providerModeMatchesRepositoryAccess(currentRepository.private, currentAccess, llm.byok)
  ) {
    console.warn(
      `respond job skipped: current visibility for ${payload.repoFullName} requires matching billing`,
    );
    return;
  }
  const existingDelivery = await getRespondDelivery(db, jobId);
  if (existingDelivery?.state === "delivered") return;
  if (existingDelivery) {
    await deliverPreparedRespond(db, token, jobId, lease);
    return;
  }
  const args = [
    "respond",
    "--forge",
    "github",
    "--repo",
    payload.repoFullName,
    payload.isPr ? "--pr" : "--issue",
    String(payload.number),
    "--no-post",
  ];

  // The mention text travels via env, not argv: argv is visible in `ps` and
  // can collide with flag parsing. Review-comment mentions carry their
  // file:line anchor so the bot knows which code the question is about.
  const context = [
    payload.commentAnchor ? `(asked on \`${payload.commentAnchor}\`)` : null,
    payload.threadContext
      ? `Postil's review comment:\n${payload.threadContext}`
      : null,
  ].filter((part): part is string => part !== null);
  const comment = context.length > 0
    ? `${context.join("\n\n")}\n\nMaintainer's message:\n${payload.comment}`
    : payload.comment;

  // Same repo-config materialization as review jobs, so replies honor the
  // repo's tone/guardrails/content-policy settings. See lib/github/contents.ts.
  const cacheDir = optionalEnv("POSTIL_CACHE_DIR", ".cache") as string;
  await mkdir(resolve(cacheDir, "workdirs"), { recursive: true });
  const workDir = await mkdtemp(resolve(cacheDir, "workdirs", "respond-"));
  let hostedUsageReservationId: string | null = null;
  let cliStarted = false;
  let hostedSpendReconciled = false;
  try {
    if (!llm.byok) {
      const reservation = await reserveHostedRespondSpend(db, {
        orgId: installation.orgId,
        usesByok: false,
      });
      if (!reservation.allowed || !reservation.reservationId) {
        console.warn(
          `respond job skipped: private repository ${payload.repoFullName} has no hosted inference capacity`,
        );
        return;
      }
      hostedUsageReservationId = reservation.reservationId;
    }
    const usageReceiptPath = resolve(workDir, "respond-usage.json");
    const cliEnv = buildCliEnv(llm, {
      GITHUB_TOKEN: token,
      POSTIL_COMMENT: comment,
      ...(hostedUsageReservationId
        ? { POSTIL_USAGE_RECEIPT_PATH: usageReceiptPath }
        : {}),
    });
    await materializeRepoConfig(token, payload.repoFullName, workDir, {
      allowModelSettings: llm.byok,
    });

    cliStarted = true;
    const result = await runCli(args, cliEnv, workDir);
    if (result.timedOut) {
      throw new Error("respond exceeded the CLI deadline");
    }
    if (result.exitCode !== 0) {
      const stderr = redactAndTruncate(result.stderr, 500, [
        token,
        llm.apiKey,
        llm.apiAuthHeader,
        llm.apiAuthValue,
      ]);
      throw new Error(
        `postil respond exited with code ${result.exitCode}: ${stderr}`,
      );
    }
    const reply = validateRespondPublication(result.stdout, payload.comment);
    const markerNonce = randomUUID();
    const body = `${reply}\n\n${respondDeliveryMarkers(jobId, markerNonce)}`;
    if (hostedUsageReservationId) {
      let usage: Awaited<ReturnType<typeof readRespondUsageReceipt>> | null = null;
      try {
        usage = await readRespondUsageReceipt(usageReceiptPath);
      } catch {
        console.error("hosted respond usage receipt was missing or invalid; charging reservation");
      }
      await reconcileHostedRespondSpend(db, {
        reservationId: hostedUsageReservationId,
        repositoryId: repository.id,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        modelUsed: usage?.modelUsed ?? "respond (conservative reservation)",
        actualMicros: usage?.actualMicros ?? null,
        usageAccountingComplete: usage?.usageAccountingComplete ?? false,
        triggerSource: payload.trigger?.source === "github_mention" ? "github_mention" : "unknown",
        delivery: {
          jobId,
          sourceOrgId: payload.sourceOrgId,
          sourceInstallationId: payload.sourceInstallationId,
          sourceGithubInstallationId: payload.installationId,
          sourceGithubRepoId: payload.githubRepoId,
          repoFullName: currentRepository.full_name,
          issueNumber: payload.number,
          isPr: payload.isPr,
          sourceHeadSha: payload.sourceHeadSha,
          markerNonce,
          replyToReviewCommentId: payload.replyToReviewCommentId,
          body,
        },
      });
      hostedSpendReconciled = true;
    } else {
      await prepareUnmeteredRespondDelivery(db, {
        jobId,
        repositoryId: repository.id,
        sourceOrgId: payload.sourceOrgId,
        sourceInstallationId: payload.sourceInstallationId,
        sourceGithubInstallationId: payload.installationId,
        sourceGithubRepoId: payload.githubRepoId,
        repoFullName: currentRepository.full_name,
        issueNumber: payload.number,
        isPr: payload.isPr,
        sourceHeadSha: payload.sourceHeadSha,
        markerNonce,
        replyToReviewCommentId: payload.replyToReviewCommentId,
        body,
      });
    }
    await deliverPreparedRespond(db, token, jobId, lease);
  } catch (error) {
    if (hostedUsageReservationId && cliStarted && !hostedSpendReconciled) {
      // Once the CLI can reach inference, absence of a validated receipt is
      // conservatively charged at the reservation. Never release potentially
      // consumed provider work as unspent after a delivery-side failure.
      await reconcileHostedRespondSpend(db, {
        reservationId: hostedUsageReservationId,
        repositoryId: repository.id,
        promptTokens: 0,
        completionTokens: 0,
        modelUsed: "respond (conservative reservation)",
        actualMicros: null,
        usageAccountingComplete: false,
        triggerSource: payload.trigger?.source === "github_mention" ? "github_mention" : "unknown",
      }).catch((reconcileError) => {
        console.error(
          `failed to conservatively reconcile hosted respond usage: ${redactSecrets(reconcileError)}`,
        );
      });
    } else if (hostedUsageReservationId && !cliStarted) {
      await releaseHostedRespondSpend(db, hostedUsageReservationId).catch((releaseError) => {
        console.error(`failed to release unused hosted respond reservation: ${redactSecrets(releaseError)}`);
      });
    }
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runRespondDeliveryJob(
  payload: RespondDeliveryJobPayload,
  lease: ExternalSideEffectLease,
): Promise<void> {
  if (!Number.isSafeInteger(payload.respondJobId) || payload.respondJobId <= 0) {
    throw new Error("respond delivery payload malformed");
  }
  const db = getDb();
  const delivery = await getRespondDelivery(db, payload.respondJobId);
  if (!delivery || delivery.state === "delivered" || delivery.state === "cancelled") return;
  const token = await getInstallationToken(delivery.githubInstallationId);
  await deliverPreparedRespond(db, token, payload.respondJobId, lease);
}

/** Deliver a fixed webhook reply through the same marker-reconciled path as a model response. */
export async function runWebhookCommentJob(
  payload: WebhookCommentJobPayload,
  lease: ExternalSideEffectLease,
): Promise<void> {
  const jobId = lease.id;
  if (
    typeof payload.installationId !== "number" ||
    typeof payload.sourceInstallationId !== "number" ||
    typeof payload.sourceOrgId !== "number" ||
    typeof payload.githubRepoId !== "number" ||
    typeof payload.repoFullName !== "string" ||
    typeof payload.number !== "number" ||
    typeof payload.body !== "string" ||
    payload.body.trim() === "" ||
    typeof payload.sourceDeliveryId !== "string" ||
    payload.sourceDeliveryId === "" ||
    !Number.isSafeInteger(jobId) ||
    jobId <= 0
  ) {
    throw new Error("webhook comment job payload malformed");
  }

  const db = getDb();
  const installation = (
    await db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, payload.installationId))
      .limit(1)
  )[0];
  if (
    !installation ||
    installation.suspended ||
    installation.id !== payload.sourceInstallationId ||
    installation.orgId !== payload.sourceOrgId
  ) {
    console.warn(
      `webhook comment skipped: installation ${payload.installationId} missing/suspended`,
    );
    return;
  }
  const repository = (
    await db
      .select()
      .from(schema.repositories)
      .where(
        and(
          eq(schema.repositories.installationId, installation.id),
          eq(schema.repositories.githubRepoId, payload.githubRepoId),
        ),
      )
      .limit(1)
  )[0];
  if (!repository || !repository.enabled || repository.fullName !== payload.repoFullName) {
    console.warn(`webhook comment skipped: repository ${payload.repoFullName} missing/disabled`);
    return;
  }

  const existing = await getRespondDelivery(db, jobId);
  if (existing?.state === "delivered") return;
  if (!existing) {
    const markerNonce = randomUUID();
    await prepareUnmeteredRespondDelivery(db, {
      jobId,
      repositoryId: repository.id,
      sourceOrgId: payload.sourceOrgId,
      sourceInstallationId: payload.sourceInstallationId,
      sourceGithubInstallationId: payload.installationId,
      sourceGithubRepoId: payload.githubRepoId,
      repoFullName: repository.fullName,
      issueNumber: payload.number,
      isPr: payload.isPr,
      sourceHeadSha: payload.sourceHeadSha,
      markerNonce,
      body: `${payload.body}\n\n${respondDeliveryMarkers(jobId, markerNonce)}`,
    });
  }
  await deliverPreparedRespond(
    db,
    await getInstallationToken(payload.installationId),
    jobId,
    lease,
  );
}

async function deliverPreparedRespond(
  db: ReturnType<typeof getDb>,
  token: string,
  jobId: number,
  queueLease: ExternalSideEffectLease,
  signal?: AbortSignal,
): Promise<void> {
  const delivery = await claimRespondDelivery(db, jobId);
  if (!delivery) {
    const existing = await getRespondDelivery(db, jobId);
    if (existing?.state === "delivered") return;
    throw new Error("respond delivery is already in progress");
  }
  const publicationLeaseId = delivery.publicationLeaseId;
  if (!publicationLeaseId) throw new Error("respond publication lease was not created");
  const marker = respondDeliveryMarkerForDelivery(delivery);
  const requestSignal = signal ?? AbortSignal.timeout(RESPOND_DELIVERY_REQUEST_TIMEOUT_MS);
  const since = new Date(delivery.createdAt.getTime() - 5 * 60_000);
  const existingCommentId = delivery.replyToReviewCommentId
    ? await findPullRequestReviewCommentByMarker(
        token,
        delivery.repoFullName,
        delivery.issueNumber,
        marker,
        since,
        requestSignal,
      )
    : await findIssueCommentByMarker(
        token,
        delivery.repoFullName,
        delivery.issueNumber,
        marker,
        since,
        requestSignal,
      );
  if (!(await authorizeRespondPublication(
    db,
    delivery,
    publicationLeaseId,
    queueLease,
    token,
    requestSignal,
  ))) {
    if (existingCommentId !== null) {
      await deletePublishedComment(
        token,
        delivery,
        existingCommentId,
        requestSignal,
      );
    }
    await markRespondCancelled(db, jobId, publicationLeaseId);
    return;
  }
  const commentId = existingCommentId ?? (delivery.replyToReviewCommentId
    ? await postPullRequestReviewCommentReply(
        token,
        delivery.repoFullName,
        delivery.issueNumber,
        delivery.replyToReviewCommentId,
        delivery.body,
        requestSignal,
      )
    : await postIssueComment(
        token,
        delivery.repoFullName,
        delivery.issueNumber,
        delivery.body,
        requestSignal,
      ));
  if (!(await authorizeRespondPublication(
    db,
    delivery,
    publicationLeaseId,
    queueLease,
    token,
    requestSignal,
  ))) {
    await deletePublishedComment(token, delivery, commentId, requestSignal);
    await markRespondCancelled(db, jobId, publicationLeaseId);
    return;
  }
  const committed = await markRespondDelivered(
    db,
    jobId,
    commentId,
    publicationLeaseId,
  );
  if (!committed) {
    await deletePublishedComment(token, delivery, commentId, requestSignal);
  }
}

async function deletePublishedComment(
  token: string,
  delivery: NonNullable<Awaited<ReturnType<typeof getRespondDelivery>>>,
  commentId: number,
  signal: AbortSignal,
): Promise<void> {
  if (delivery.replyToReviewCommentId) {
    await deletePullRequestReviewComment(
      token,
      delivery.repoFullName,
      commentId,
      signal,
    );
    return;
  }
  await deleteIssueComment(token, delivery.repoFullName, commentId, signal);
}

/** Revalidate GitHub and durable authority immediately around the POST. */
async function authorizeRespondPublication(
  db: ReturnType<typeof getDb>,
  delivery: NonNullable<Awaited<ReturnType<typeof getRespondDelivery>>>,
  publicationLeaseId: string,
  queueLease: ExternalSideEffectLease,
  token: string,
  signal: AbortSignal,
): Promise<boolean> {
  const queueActive = await externalSideEffectLeaseActive(getPool(), queueLease);
  const publicationActive = await respondPublicationLeaseActive(
    db,
    delivery.jobId,
    publicationLeaseId,
  );
  if (!queueActive || !publicationActive) {
    return false;
  }
  if (
    delivery.sourceOrgId === null ||
    delivery.sourceInstallationId === null ||
    delivery.sourceGithubInstallationId === null ||
    delivery.sourceGithubRepoId === null
  ) {
    return false;
  }
  const repository = await fetchRepositorySummary(token, delivery.repoFullName, signal);
  if (
    repository.id !== delivery.sourceGithubRepoId ||
    repository.full_name !== delivery.repoFullName
  ) {
    return false;
  }
  if (delivery.isPr) {
    if (!delivery.sourceHeadSha) return false;
    const current = await getPullRequestReviewContext(
      token,
      delivery.repoFullName,
      delivery.issueNumber,
      signal,
    );
    if (
      !current.open ||
      current.merged ||
      current.draft ||
      current.headSha !== delivery.sourceHeadSha
    ) return false;
  }
  const authority = (
    await db
      .select({ repositoryId: schema.repositories.id })
      .from(schema.repositories)
      .innerJoin(
        schema.installations,
        eq(schema.repositories.installationId, schema.installations.id),
      )
      .where(and(
        eq(schema.repositories.id, delivery.repositoryId),
        eq(schema.repositories.installationId, delivery.sourceInstallationId),
        eq(schema.repositories.githubRepoId, delivery.sourceGithubRepoId),
        eq(schema.repositories.fullName, delivery.repoFullName),
        eq(schema.repositories.enabled, true),
        eq(
          schema.installations.githubInstallationId,
          delivery.sourceGithubInstallationId,
        ),
        eq(schema.installations.orgId, delivery.sourceOrgId),
        eq(schema.installations.suspended, false),
      ))
      .limit(1)
  )[0];
  return authority !== undefined &&
    await externalSideEffectLeaseActive(getPool(), queueLease) &&
    await respondPublicationLeaseActive(db, delivery.jobId, publicationLeaseId);
}

/** The user-facing message posted when a respond job exhausts its retries. */
export const RESPOND_FAILURE_COMMENT =
  "Postil couldn't complete this request. Please try again.";
export const RESPOND_FAILURE_COMMENT_TIMEOUT_MS = 10_000;

/**
 * Post one brief, honest fallback comment after a respond job has been
 * permanently failed (retries exhausted). The failed respond job id is also
 * the durable delivery id, so a lost POST response is reconciled by marker
 * instead of producing another comment.
 *
 * Never throws: a respond job is already failed when this runs, so a failed
 * comment POST must not turn into an unhandled rejection in the worker loop.
 * It is also silent for genuinely skipped work (installation missing/suspended
 * or repository missing/disabled) — those jobs complete, they do not fail, but
 * we re-check defensively so a suspended install never gets an unwanted ping.
 */
export async function postRespondFailureComment(
  payload: RespondJobPayload,
  respondJobId: number,
  lease: ExternalSideEffectLease,
  signal?: AbortSignal,
  timeoutMs = RESPOND_FAILURE_COMMENT_TIMEOUT_MS,
  throwOnError = false,
): Promise<void> {
  const requestSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try {
    // A malformed payload that failed every attempt may lack the routing
    // fields; there is nothing to post to.
    if (
      typeof payload.installationId !== "number" ||
      typeof payload.sourceInstallationId !== "number" ||
      typeof payload.sourceOrgId !== "number" ||
      typeof payload.githubRepoId !== "number" ||
      typeof payload.repoFullName !== "string" ||
      typeof payload.number !== "number" ||
      (payload.replyToReviewCommentId !== undefined &&
        (!Number.isSafeInteger(payload.replyToReviewCommentId) ||
          payload.replyToReviewCommentId <= 0 ||
          !payload.isPr)) ||
      !Number.isSafeInteger(respondJobId) ||
      respondJobId <= 0
    ) {
      console.warn("respond failure comment skipped: payload missing routing fields");
      return;
    }

    const db = getDb();
    const existingDelivery = await getRespondDelivery(db, respondJobId);
    if (existingDelivery?.state === "delivered") return;
    const installation = (
      await db
        .select()
        .from(schema.installations)
        .where(eq(schema.installations.githubInstallationId, payload.installationId))
        .limit(1)
    )[0];
    if (
      !installation ||
      installation.suspended ||
      installation.id !== payload.sourceInstallationId ||
      installation.orgId !== payload.sourceOrgId
    ) {
      console.warn(
        `respond failure comment skipped: installation ${payload.installationId} missing/suspended`,
      );
      return;
    }
    const repository = (
      await db
        .select()
        .from(schema.repositories)
        .where(
          and(
            eq(schema.repositories.installationId, installation.id),
            eq(schema.repositories.githubRepoId, payload.githubRepoId),
          ),
        )
        .limit(1)
    )[0];
    if (!repository || !repository.enabled || repository.fullName !== payload.repoFullName) {
      console.warn(
        `respond failure comment skipped: repository ${payload.repoFullName} missing/disabled`,
      );
      return;
    }
    const access = await canProcessRepositoryInference(db, {
      orgId: installation.orgId,
      repositoryPrivate: repository.private,
    });
    const llm = await resolveLlmConfig(installation.orgId);
    if (
      !access.allowed ||
      !providerModeMatchesRepositoryAccess(repository.private, access, llm.byok) ||
      (!llm.byok && !(await hostedInferenceAvailable(getPool())))
    ) {
      console.warn(
        `respond failure comment skipped: repository ${payload.repoFullName} has no active inference access`,
      );
      return;
    }

    if (!existingDelivery) {
      const markerNonce = randomUUID();
      await prepareUnmeteredRespondDelivery(db, {
        jobId: respondJobId,
        repositoryId: repository.id,
        sourceOrgId: payload.sourceOrgId,
        sourceInstallationId: payload.sourceInstallationId,
        sourceGithubInstallationId: payload.installationId,
        sourceGithubRepoId: payload.githubRepoId,
        repoFullName: payload.repoFullName,
        issueNumber: payload.number,
        isPr: payload.isPr,
        sourceHeadSha: payload.sourceHeadSha,
        markerNonce,
        replyToReviewCommentId: payload.replyToReviewCommentId,
        body: `${RESPOND_FAILURE_COMMENT}\n\n${respondDeliveryMarkers(
          respondJobId,
          markerNonce,
        )}`,
      });
    }
    const token = await getInstallationToken(payload.installationId, requestSignal);
    await deliverPreparedRespond(db, token, respondJobId, lease, requestSignal);
    console.warn(
      `respond failure comment posted to ${payload.repoFullName}#${payload.number}`,
    );
  } catch (err) {
    // Swallow: the job is already failed; a failed fallback comment must not
    // re-throw into the worker loop.
    console.error(
      `respond failure comment could not be posted: ${redactSecrets(err)}`,
    );
    if (throwOnError) throw err;
  }
}

/** Retryable worker job for a terminal respond-job fallback comment. */
export async function runRespondFailureCommentJob(
  payload: RespondFailureCommentJobPayload,
  lease: ExternalSideEffectLease,
): Promise<void> {
  await postRespondFailureComment(
    payload,
    payload.respondJobId,
    lease,
    undefined,
    RESPOND_FAILURE_COMMENT_TIMEOUT_MS,
    true,
  );
}
