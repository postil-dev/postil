import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { and, eq } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  findIssueCommentByMarker,
  postIssueComment,
} from "@/lib/github/checks";
import { materializeRepoConfig } from "@/lib/github/contents";
import { fetchRepositorySummary } from "@/lib/github/installation-sync";
import type { RespondJobPayload } from "@/lib/queue";
import {
  canProcessPrivateRepository,
  providerModeMatchesPrivateAccess,
} from "@/lib/private-repository-entitlement";
import {
  reconcileHostedRespondSpend,
  releaseHostedRespondSpend,
  reserveHostedRespondSpend,
} from "@/lib/hosted-usage-reservations";
import { redactAndTruncate, redactSecrets } from "@/lib/redact";
import { readRespondUsageReceipt } from "@/lib/respond-usage-receipt";
import {
  claimRespondDelivery,
  getRespondDelivery,
  markRespondDelivered,
  prepareUnmeteredRespondDelivery,
  RESPOND_DELIVERY_REQUEST_TIMEOUT_MS,
  respondDeliveryMarker,
} from "@/lib/respond-delivery";
import { buildCliEnv, resolveLlmConfig, runCli } from "./review";

/**
 * Run one interactive bot reply: an @postil mention on a PR or issue.
 *
 * Like the review job, the worker stays thin — mint a token, set the LLM
 * environment, and let the CLI fetch context, generate the answer, and post
 * the reply. Postil only reviews and answers; it never opens PRs or pushes.
 */
export async function runRespondJob(payload: RespondJobPayload, jobId: number): Promise<void> {
  // A malformed row must fail loudly, not spawn the CLI with "undefined" argv.
  if (
    typeof payload.installationId !== "number" ||
    typeof payload.repoFullName !== "string" ||
    typeof payload.number !== "number" ||
    typeof payload.comment !== "string" ||
    payload.comment.trim() === ""
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
  if (!installation || installation.suspended) {
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
          eq(schema.repositories.fullName, payload.repoFullName),
        ),
      )
      .limit(1)
  )[0];
  if (!repository || !repository.enabled) {
    console.warn(`respond job skipped: repository ${payload.repoFullName} missing or disabled`);
    return;
  }
  const signedOrStoredPrivate = repository.private || payload.repositoryPrivate === true;
  const privateAccess = await canProcessPrivateRepository(db, {
    orgId: installation.orgId,
    repositoryPrivate: signedOrStoredPrivate,
  });
  if (!privateAccess.allowed) {
    console.warn(`respond job skipped: private repository ${payload.repoFullName} requires billing`);
    return;
  }

  const llm = await resolveLlmConfig(installation.orgId);
  if (!providerModeMatchesPrivateAccess(signedOrStoredPrivate, privateAccess, llm.byok)) {
    console.warn(
      `respond job skipped: private repository ${payload.repoFullName} provider mode does not match billing`,
    );
    return;
  }

  const token = await getInstallationToken(payload.installationId);
  const currentRepository = await fetchRepositorySummary(token, payload.repoFullName);
  await db
    .update(schema.repositories)
    .set({ fullName: currentRepository.full_name, private: currentRepository.private })
    .where(eq(schema.repositories.id, repository.id));
  const currentAccess = await canProcessPrivateRepository(db, {
    orgId: installation.orgId,
    repositoryPrivate: currentRepository.private,
  });
  if (
    !currentAccess.allowed ||
    !providerModeMatchesPrivateAccess(currentRepository.private, currentAccess, llm.byok)
  ) {
    console.warn(
      `respond job skipped: current visibility for ${payload.repoFullName} requires matching billing`,
    );
    return;
  }
  const existingDelivery = await getRespondDelivery(db, jobId);
  if (existingDelivery?.state === "delivered") return;
  if (existingDelivery) {
    await deliverPreparedRespond(db, token, jobId);
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
  const comment = payload.commentAnchor
    ? `(asked on \`${payload.commentAnchor}\`)\n\n${payload.comment}`
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
    if (currentRepository.private && !llm.byok) {
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
    const reply = result.stdout.trim();
    if (!reply || reply.length > 65_000) throw new Error("postil respond produced an invalid reply");
    const body = `${reply}\n\n${respondDeliveryMarker(jobId)}`;
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
        delivery: {
          jobId,
          repoFullName: currentRepository.full_name,
          issueNumber: payload.number,
          body,
        },
      });
      hostedSpendReconciled = true;
    } else {
      await prepareUnmeteredRespondDelivery(db, {
        jobId,
        repositoryId: repository.id,
        repoFullName: currentRepository.full_name,
        issueNumber: payload.number,
        body,
      });
    }
    await deliverPreparedRespond(db, token, jobId);
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

async function deliverPreparedRespond(
  db: ReturnType<typeof getDb>,
  token: string,
  jobId: number,
): Promise<void> {
  const delivery = await claimRespondDelivery(db, jobId);
  if (!delivery) {
    const existing = await getRespondDelivery(db, jobId);
    if (existing?.state === "delivered") return;
    throw new Error("respond delivery is already in progress");
  }
  const marker = respondDeliveryMarker(jobId);
  const signal = AbortSignal.timeout(RESPOND_DELIVERY_REQUEST_TIMEOUT_MS);
  const existingCommentId = await findIssueCommentByMarker(
    token,
    delivery.repoFullName,
    delivery.issueNumber,
    marker,
    new Date(delivery.createdAt.getTime() - 5 * 60_000),
    signal,
  );
  const commentId = existingCommentId ?? await postIssueComment(
    token,
    delivery.repoFullName,
    delivery.issueNumber,
    delivery.body,
    signal,
  );
  await markRespondDelivered(db, jobId, commentId);
}

/** The user-facing message posted when a respond job exhausts its retries. */
export const RESPOND_FAILURE_COMMENT =
  "Postil could not complete this request after several attempts. " +
  "The maintainers can re-run by mentioning @postil again, or check the run logs.";
export const RESPOND_FAILURE_COMMENT_TIMEOUT_MS = 10_000;

/**
 * Post one brief, honest fallback comment after a respond job has been
 * permanently failed (retries exhausted). Call this only when the job has
 * actually transitioned to `failed`, and only once — the queue's conditional
 * transition (failJob returning "failed") is the single-post guard.
 *
 * Never throws: a respond job is already failed when this runs, so a failed
 * comment POST must not turn into an unhandled rejection in the worker loop.
 * It is also silent for genuinely skipped work (installation missing/suspended
 * or repository missing/disabled) — those jobs complete, they do not fail, but
 * we re-check defensively so a suspended install never gets an unwanted ping.
 */
export async function postRespondFailureComment(
  payload: RespondJobPayload,
  signal?: AbortSignal,
  timeoutMs = RESPOND_FAILURE_COMMENT_TIMEOUT_MS,
  throwOnError = false,
  respondJobId?: number,
): Promise<void> {
  const requestSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try {
    // A malformed payload that failed every attempt may lack the routing
    // fields; there is nothing to post to.
    if (
      typeof payload.installationId !== "number" ||
      typeof payload.repoFullName !== "string" ||
      typeof payload.number !== "number"
    ) {
      console.warn("respond failure comment skipped: payload missing routing fields");
      return;
    }

    const db = getDb();
    if (respondJobId && await getRespondDelivery(db, respondJobId)) {
      console.warn("respond failure comment skipped: a durable answer delivery exists");
      return;
    }
    const installation = (
      await db
        .select()
        .from(schema.installations)
        .where(eq(schema.installations.githubInstallationId, payload.installationId))
        .limit(1)
    )[0];
    if (!installation || installation.suspended) {
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
            eq(schema.repositories.fullName, payload.repoFullName),
          ),
        )
        .limit(1)
    )[0];
    if (!repository || !repository.enabled) {
      console.warn(
        `respond failure comment skipped: repository ${payload.repoFullName} missing/disabled`,
      );
      return;
    }
    if (
      !(await canProcessPrivateRepository(db, {
        orgId: installation.orgId,
        repositoryPrivate: repository.private,
      })).allowed
    ) {
      console.warn(
        `respond failure comment skipped: private repository ${payload.repoFullName} requires billing`,
      );
      return;
    }

    const token = await getInstallationToken(payload.installationId, requestSignal);
    await postIssueComment(
      token,
      payload.repoFullName,
      payload.number,
      RESPOND_FAILURE_COMMENT,
      requestSignal,
    );
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
export async function runRespondFailureCommentJob(payload: RespondJobPayload): Promise<void> {
  await postRespondFailureComment(
    payload,
    undefined,
    RESPOND_FAILURE_COMMENT_TIMEOUT_MS,
    true,
  );
}
