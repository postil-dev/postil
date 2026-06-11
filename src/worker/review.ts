import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { getSealingKey, unseal } from "@/lib/crypto/seal";
import { getDb, schema } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { ingestEnvelope } from "@/lib/envelope";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  ADVISORY_CHECK_NAME,
  GATE_CHECK_NAME,
  completeCheckRun,
  createCheckRun,
} from "@/lib/github/checks";
import type { ReviewJobPayload } from "@/lib/queue";

export const REVIEW_DEADLINE_MS = 10 * 60 * 1000;

const CACHE_DIR = optionalEnv("POSTIL_CACHE_DIR", ".cache") as string;

class OperationalError extends Error {}

interface CliEnvConfig {
  apiBase: string;
  apiKey: string | undefined;
  model: string | undefined;
  modelCascade: string | undefined;
}

/** Resolve LLM config: org BYO settings win, env defaults otherwise. */
export async function resolveLlmConfig(orgId: number | null): Promise<CliEnvConfig> {
  const defaults: CliEnvConfig = {
    apiBase: optionalEnv("POSTIL_API_BASE", "https://openrouter.ai/api/v1") as string,
    apiKey: optionalEnv("POSTIL_API_KEY") ?? optionalEnv("OPENROUTER_API_KEY"),
    model: optionalEnv("REVIEW_MODEL"),
    modelCascade: optionalEnv("REVIEW_MODEL_CASCADE"),
  };
  if (orgId == null) return defaults;
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.orgSettings)
    .where(eq(schema.orgSettings.orgId, orgId))
    .limit(1);
  const settings = rows[0];
  if (!settings) return defaults;
  let apiKey = defaults.apiKey;
  if (settings.apiKeyCiphertext) {
    apiKey = unseal(Buffer.from(settings.apiKeyCiphertext), getSealingKey());
  }
  return {
    apiBase: settings.apiBase ?? defaults.apiBase,
    apiKey,
    model: settings.model ?? defaults.model,
    modelCascade: settings.modelCascade ?? defaults.modelCascade,
  };
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const bin = optionalEnv("POSTIL_BIN", "postil") as string;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, REVIEW_DEADLINE_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new OperationalError(
          `failed to spawn postil CLI (${bin}): ${err.message}. Set POSTIL_BIN or put 'postil' on PATH.`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Run one hosted review end to end.
 *
 * The worker's job is deliberately small: mint a token, create the two
 * check-runs (so it owns their ids even if the CLI crashes), spawn the CLI,
 * store the envelope, and mark the check-runs failed on crash/timeout. All
 * review logic lives in the CLI.
 */
export async function runReviewJob(payload: ReviewJobPayload): Promise<void> {
  const db = getDb();

  const installation = (
    await db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, payload.installationId))
      .limit(1)
  )[0];
  if (!installation) {
    console.warn(`review job skipped: unknown installation ${payload.installationId}`);
    return;
  }
  if (installation.suspended) {
    console.warn(`review job skipped: installation ${payload.installationId} suspended`);
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
    console.warn(`review job skipped: repository ${payload.repoFullName} missing or disabled`);
    return;
  }

  // This attempt supersedes any still-pending review of the PR: older heads
  // (a newer push landed) and orphans of crashed earlier attempts alike.
  await db
    .update(schema.reviews)
    .set({ status: "stale", finishedAt: new Date() })
    .where(
      and(
        eq(schema.reviews.repositoryId, repository.id),
        eq(schema.reviews.prNumber, payload.prNumber),
        inArray(schema.reviews.status, ["queued", "running"]),
      ),
    );

  // Incremental re-review: baseline = last completed review of this PR.
  const baseline = (
    await db
      .select()
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.repositoryId, repository.id),
          eq(schema.reviews.prNumber, payload.prNumber),
          eq(schema.reviews.status, "completed"),
          isNotNull(schema.reviews.envelope),
        ),
      )
      .orderBy(desc(schema.reviews.finishedAt))
      .limit(1)
  )[0];

  const inserted = await db
    .insert(schema.reviews)
    .values({
      repositoryId: repository.id,
      prNumber: payload.prNumber,
      headSha: payload.headSha,
      baseSha: payload.baseSha,
      sinceSha: baseline?.headSha ?? null,
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: schema.reviews.id });
  const reviewId = inserted[0]?.id;
  if (reviewId === undefined) throw new Error("review insert returned no row");

  let token: string | undefined;
  let advisoryCheckRunId: number | undefined;
  let gateCheckRunId: number | undefined;
  let baselinePath: string | undefined;

  try {
    token = await getInstallationToken(payload.installationId);
    advisoryCheckRunId = await createCheckRun(
      token,
      payload.repoFullName,
      ADVISORY_CHECK_NAME,
      payload.headSha,
    );
    gateCheckRunId = await createCheckRun(
      token,
      payload.repoFullName,
      GATE_CHECK_NAME,
      payload.headSha,
    );
    await db
      .update(schema.reviews)
      .set({ advisoryCheckRunId, gateCheckRunId })
      .where(eq(schema.reviews.id, reviewId));

    const args = [
      "review",
      "--forge",
      "github",
      "--repo",
      payload.repoFullName,
      "--pr",
      String(payload.prNumber),
      "--sha",
      payload.headSha,
      "--check-run-id",
      String(advisoryCheckRunId),
      "--gate-check-run-id",
      String(gateCheckRunId),
    ];
    if (baseline?.envelope) {
      await mkdir(join(CACHE_DIR, "baselines"), { recursive: true });
      baselinePath = join(CACHE_DIR, "baselines", `review-${reviewId}.json`);
      await writeFile(baselinePath, JSON.stringify(baseline.envelope));
      args.push("--since-sha", baseline.headSha, "--baseline", baselinePath);
    }
    args.push("--output-json");

    const llm = await resolveLlmConfig(installation.orgId);
    const cliEnv: Record<string, string> = {
      GITHUB_TOKEN: token,
      POSTIL_API_BASE: llm.apiBase,
    };
    if (llm.apiKey) cliEnv.POSTIL_API_KEY = llm.apiKey;
    if (llm.model) cliEnv.REVIEW_MODEL = llm.model;
    if (llm.modelCascade) cliEnv.REVIEW_MODEL_CASCADE = llm.modelCascade;

    const result = await runCli(args, cliEnv);

    if (result.timedOut) {
      throw new OperationalError(`review exceeded ${REVIEW_DEADLINE_MS / 60000} minute deadline`);
    }
    // Exit 0 = clean/below gate, 1 = gate-failing findings; both produce a
    // valid envelope. 2 (or anything else) is an operational error.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new OperationalError(
        `postil CLI exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
      );
    }

    const ingested = ingestEnvelope(result.stdout);

    await db
      .update(schema.reviews)
      .set({
        status: "completed",
        envelope: ingested.envelope,
        silent: ingested.silent,
        gateFailing: ingested.gateFailing,
        finishedAt: new Date(),
      })
      .where(eq(schema.reviews.id, reviewId));

    await db.insert(schema.usageEvents).values({
      orgId: installation.orgId,
      repositoryId: repository.id,
      reviewId,
      promptTokens: ingested.promptTokens,
      completionTokens: ingested.completionTokens,
      modelUsed: ingested.modelUsed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.reviews)
      .set({ status: "failed", errorMessage: message.slice(0, 2000), finishedAt: new Date() })
      .where(eq(schema.reviews.id, reviewId));
    // Without a token there are no check-runs to complete (creation is the
    // first tokened call); with one, fail them closed.
    if (token) {
      await failCheckRuns(token, payload.repoFullName, advisoryCheckRunId, gateCheckRunId, message);
    }
    throw err;
  } finally {
    if (baselinePath) await rm(baselinePath, { force: true }).catch(() => undefined);
  }
}

/**
 * Complete both check-runs after an operational failure. The gate fails
 * closed (`failure`); the advisory check is `neutral` because there is no
 * review verdict, only an operational error.
 */
export async function failCheckRuns(
  token: string,
  repoFullName: string,
  advisoryCheckRunId: number | undefined | null,
  gateCheckRunId: number | undefined | null,
  message: string,
): Promise<void> {
  const summary = `Postil could not complete this review: ${message.slice(0, 400)}`;
  if (gateCheckRunId != null) {
    await completeCheckRun(
      token,
      repoFullName,
      gateCheckRunId,
      "failure",
      "Review did not complete",
      `${summary}\n\nThe gate fails closed: an unreviewed head is not a passing head. Re-run by pushing or re-requesting the check.`,
    ).catch((e) => console.error(`failed to complete gate check-run: ${e}`));
  }
  if (advisoryCheckRunId != null) {
    await completeCheckRun(
      token,
      repoFullName,
      advisoryCheckRunId,
      "neutral",
      "Review did not complete",
      summary,
    ).catch((e) => console.error(`failed to complete advisory check-run: ${e}`));
  }
}
