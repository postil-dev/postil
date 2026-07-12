import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { and, eq } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { getInstallationToken } from "@/lib/github/app-auth";
import { postIssueComment } from "@/lib/github/checks";
import { materializeRepoConfig } from "@/lib/github/contents";
import { fetchRepositorySummary } from "@/lib/github/installation-sync";
import type { RespondJobPayload } from "@/lib/queue";
import {
  canProcessPrivateRepository,
  providerModeMatchesPrivateAccess,
} from "@/lib/private-repository-entitlement";
import { redactAndTruncate, redactSecrets } from "@/lib/redact";
import { buildCliEnv, resolveLlmConfig, runCli } from "./review";

/**
 * Run one interactive bot reply: an @postil mention on a PR or issue.
 *
 * Like the review job, the worker stays thin — mint a token, set the LLM
 * environment, and let the CLI fetch context, generate the answer, and post
 * the reply. Postil only reviews and answers; it never opens PRs or pushes.
 */
export async function runRespondJob(payload: RespondJobPayload): Promise<void> {
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
  const args = [
    "respond",
    "--forge",
    "github",
    "--repo",
    payload.repoFullName,
    payload.isPr ? "--pr" : "--issue",
    String(payload.number),
  ];

  // The mention text travels via env, not argv: argv is visible in `ps` and
  // can collide with flag parsing. Review-comment mentions carry their
  // file:line anchor so the bot knows which code the question is about.
  const comment = payload.commentAnchor
    ? `(asked on \`${payload.commentAnchor}\`)\n\n${payload.comment}`
    : payload.comment;

  const cliEnv = buildCliEnv(llm, {
    GITHUB_TOKEN: token,
    POSTIL_COMMENT: comment,
  });

  // Same repo-config materialization as review jobs, so replies honor the
  // repo's tone/guardrails/content-policy settings. See lib/github/contents.ts.
  const cacheDir = optionalEnv("POSTIL_CACHE_DIR", ".cache") as string;
  await mkdir(resolve(cacheDir, "workdirs"), { recursive: true });
  const workDir = await mkdtemp(resolve(cacheDir, "workdirs", "respond-"));
  try {
    await materializeRepoConfig(token, payload.repoFullName, workDir, {
      allowModelSettings: llm.byok,
    });

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
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
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
