import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { logger, task, tasks } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { installationOctokit, mintInstallationToken } from "@/lib/github";
import { captureException, hashInstallationId, track } from "@/lib/posthog";
import { decryptReviewInstallationToken } from "@/lib/review-token";
import { recordReviewCompleted, recordTokenUsage } from "@/lib/usage";
import {
  type ReviewEnvelope,
  type ReviewPayload,
  reviewEnvelope,
  reviewPayload,
} from "./review-types";

const execFile = promisify(execFileCb);
const REVIEW_CLI_TIMEOUT_MS = 8 * 60 * 1000;

const reviewWorkerFailureStages = [
  "runtime_env_bootstrap",
  "cli_unavailable",
  "github_token_check_completion",
  "model_provider_call",
] as const;

type ReviewWorkerFailureStage = (typeof reviewWorkerFailureStages)[number];

type StagedError = Error & {
  code?: unknown;
  reviewWorkerFailureStage?: ReviewWorkerFailureStage;
};

function safePayload(payload: ReviewPayload): Omit<ReviewPayload, "encryptedInstallationToken"> {
  const { encryptedInstallationToken: _encryptedInstallationToken, ...safe } = payload;
  return safe;
}

function requireTriggerSecretKey(): string {
  const secret = env.reviewTokenSecret?.trim();
  if (!secret) {
    throw withWorkerFailureStage(
      new Error("REVIEW_TOKEN_SECRET must be set to decrypt review installation tokens"),
      "runtime_env_bootstrap",
    );
  }
  return secret;
}

function decryptedInstallationToken(payload: ReviewPayload): string | undefined {
  if (!payload.encryptedInstallationToken) return undefined;
  const triggerSecretKey = requireTriggerSecretKey();
  return decryptReviewInstallationToken({
    encryptedToken: payload.encryptedInstallationToken,
    secret: triggerSecretKey,
    context: {
      installationId: payload.installationId,
      repoFullName: payload.repoFullName,
      pullNumber: payload.pullNumber,
      headSha: payload.headSha,
    },
  });
}

async function reviewOctokit(payload: ReviewPayload): Promise<{ request: Octokit["request"] }> {
  const token = decryptedInstallationToken(payload);
  if (token) {
    return new Octokit({ auth: token });
  }
  return installationOctokit(payload.installationId);
}

function triggerClientConfig() {
  if (!env.triggerApiKey) {
    throw new Error("Trigger API token must be set to dispatch review tasks");
  }
  if (!env.TRIGGER_PROJECT_ID?.trim()) {
    throw new Error("TRIGGER_PROJECT_ID must be set to dispatch review tasks");
  }

  return {
    baseURL: env.TRIGGER_API_URL,
    accessToken: env.triggerApiKey,
  };
}

function selectedReviewModel(): string {
  const raw = env.REVIEW_MODEL_CASCADE?.trim() ? env.REVIEW_MODEL_CASCADE : env.REVIEW_MODEL;
  return (
    raw
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)[0] ?? env.REVIEW_MODEL
  );
}

function publicReviewErrorMessage(): string {
  return "Review failed to complete.";
}

function publicReviewFailureSummary(stage: ReviewWorkerFailureStage): string {
  switch (stage) {
    case "runtime_env_bootstrap":
      return "Review failed during runtime env/bootstrap.";
    case "cli_unavailable":
      return "Review failed because the CLI package/binary/path is unavailable.";
    case "github_token_check_completion":
      return "Review failed during GitHub token/check completion.";
    case "model_provider_call":
      return "Review failed during model/provider call.";
  }
}

function publicReviewFailureText(stage: ReviewWorkerFailureStage): string {
  return `${publicReviewErrorMessage()} Worker stage: ${stage}. ${publicReviewFailureSummary(stage)}`;
}

function withWorkerFailureStage<T extends Error>(
  err: T,
  stage: ReviewWorkerFailureStage,
): T & { reviewWorkerFailureStage: ReviewWorkerFailureStage } {
  return Object.assign(err, { reviewWorkerFailureStage: stage });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
}

function isCliUnavailableError(err: unknown): boolean {
  const code = errorCode(err);
  const message = errorMessage(err).toLowerCase();
  return (
    code === "ENOENT" ||
    code === 127 ||
    message.includes("no such file or directory") ||
    message.includes("command not found")
  );
}

function classifyReviewWorkerFailure(err: unknown): ReviewWorkerFailureStage {
  if (err instanceof Error) {
    const staged = err as StagedError;
    if (
      staged.reviewWorkerFailureStage &&
      reviewWorkerFailureStages.includes(staged.reviewWorkerFailureStage)
    ) {
      return staged.reviewWorkerFailureStage;
    }
  }

  if (isCliUnavailableError(err)) return "cli_unavailable";

  const message = errorMessage(err).toLowerCase();
  if (
    message.includes("github") ||
    message.includes("installation token") ||
    message.includes("check-run") ||
    message.includes("check run")
  ) {
    return "github_token_check_completion";
  }

  if (
    message.includes("openrouter") ||
    message.includes("model") ||
    message.includes("provider") ||
    message.includes("timeout")
  ) {
    return "model_provider_call";
  }

  return "model_provider_call";
}

function hasDatabaseUrl(): boolean {
  return Boolean(env.databaseUrl);
}

function logDatabaseSkip(op: string, payload: ReviewPayload): void {
  logger.info("skipping review database write", {
    op,
    repoFullName: payload.repoFullName,
    pullNumber: payload.pullNumber,
    headSha: payload.headSha,
    reviewId: payload.reviewId,
    reason: "database url not configured",
  });
}

function checkRunConclusionForResult(result: ReviewEnvelope): "success" | "neutral" | "failure" {
  if (result.findings.some((finding) => finding.severity === "error")) return "failure";
  if (result.findings.some((finding) => finding.severity === "warn")) return "neutral";
  return "success";
}

async function completeCheckRunForResult(
  payload: ReviewPayload,
  result: ReviewEnvelope,
): Promise<void> {
  if (!payload.checkRunId) return;

  const octokit = await reviewOctokit(payload);
  const [owner, repo] = payload.repoFullName.split("/");
  const conclusion = checkRunConclusionForResult(result);
  const summary =
    conclusion === "failure"
      ? result.summary || "Review completed with blocking findings."
      : "Review completed with no blocking findings.";

  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: payload.checkRunId,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: "Postil Review",
      summary,
      text: summary,
    },
  });
}

async function completeCheckRunFailed(
  payload: ReviewPayload,
  stage: ReviewWorkerFailureStage,
): Promise<void> {
  if (!payload.checkRunId) return;
  const octokit = await installationOctokit(payload.installationId);
  const [owner, repo] = payload.repoFullName.split("/");
  const publicText = publicReviewFailureText(stage);
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: payload.checkRunId,
    status: "completed",
    conclusion: "failure",
    completed_at: new Date().toISOString(),
    output: {
      title: "Postil Review",
      summary: publicText,
      text: publicText,
    },
  });
}

async function markReviewFailed(
  payload: ReviewPayload,
  stage: ReviewWorkerFailureStage,
): Promise<void> {
  if (!payload.reviewId) return;
  if (!hasDatabaseUrl()) {
    logDatabaseSkip("mark_review_failed", payload);
    return;
  }
  const db = getDb();
  await db
    .update(schema.reviews)
    .set({
      status: "failed",
      errorMessage: publicReviewFailureText(stage),
      completedAt: new Date(),
    })
    .where(eq(schema.reviews.id, payload.reviewId));
}

async function runReviewCli(payload: ReviewPayload): Promise<ReviewEnvelope> {
  const runDir = join(tmpdir(), "postil-runs", randomUUID());
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const configPath = join(runDir, "config.json");
  const outputPath = join(runDir, "review.json");
  try {
    const installationToken =
      decryptedInstallationToken(payload) ??
      (await mintInstallationToken(payload.installationId).catch((err) => {
        throw withWorkerFailureStage(
          err instanceof Error ? err : new Error(String(err)),
          "github_token_check_completion",
        );
      }));
    await writeFile(
      configPath,
      JSON.stringify({
        githubToken: installationToken,
        openrouterApiKey: env.OPENROUTER_API_KEY,
        repo: payload.repoFullName,
        pr: payload.pullNumber,
        sha: payload.headSha,
        checkRunId: payload.checkRunId,
        reviewModel: env.REVIEW_MODEL,
        reviewModelCascade: env.REVIEW_MODEL_CASCADE,
      }),
      { mode: 0o600 },
    );

    const cli = env.POSTIL_CLI_PATH ?? "postil";
    try {
      await execFile(cli, ["review", "--config", configPath, "--output-json", outputPath], {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
        timeout: REVIEW_CLI_TIMEOUT_MS,
      });
    } catch (err) {
      try {
        const result = reviewEnvelope.parse(JSON.parse(await readFile(outputPath, "utf8")));
        if (isExpectedFindingsExit(err) && result.findings.length > 0) {
          return result;
        }
      } catch {
        // Preserve the original CLI failure when no valid review envelope exists.
      }
      throw withWorkerFailureStage(
        err instanceof Error ? err : new Error(String(err)),
        isCliUnavailableError(err) ? "cli_unavailable" : "model_provider_call",
      );
    }
    try {
      return reviewEnvelope.parse(JSON.parse(await readFile(outputPath, "utf8")));
    } catch (err) {
      throw withWorkerFailureStage(
        err instanceof Error ? err : new Error(String(err)),
        "model_provider_call",
      );
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

function isExpectedFindingsExit(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === 1;
}

export const reviewPullRequest = task({
  id: "review-pull-request",
  maxDuration: 10 * 60,
  run: async (raw: unknown) => {
    const payload = reviewPayload.parse(raw);
    logger.info("starting review", { payload: safePayload(payload) });
    const started = Date.now();
    const reviewModelUsed = selectedReviewModel();
    let installationHash: string | undefined;

    try {
      installationHash = await hashInstallationId(payload.installationId);
      track("system", "review_started", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        headSha: payload.headSha,
        modelUsed: reviewModelUsed,
        installationHash,
      });

      const result = await runReviewCli(payload);

      try {
        await completeCheckRunForResult(payload, result);
      } catch (checkRunErr) {
        captureException(new Error("postil review check-run completion patch failed"), {
          properties: {
            op: "complete_review_check_run",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
            errorClass: checkRunErr instanceof Error ? checkRunErr.name : typeof checkRunErr,
          },
        });
      }

      if (payload.reviewId) {
        try {
          if (hasDatabaseUrl()) {
            const db = getDb();
            await db
              .update(schema.reviews)
              .set({
                status: "completed",
                result,
                completedAt: new Date(),
              })
              .where(eq(schema.reviews.id, payload.reviewId));
          } else {
            logDatabaseSkip("update_review_completed", payload);
          }
        } catch (dbErr) {
          captureException(dbErr, {
            properties: {
              op: "update_review_completed",
              repoFullName: payload.repoFullName,
              pullNumber: payload.pullNumber,
            },
          });
        }
      }

      track("system", "review_completed", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        findings: result.findings.length,
        durationMs: Date.now() - started,
        modelUsed: result.modelUsed ?? reviewModelUsed,
        installationHash,
      });

      try {
        if (payload.reviewId) {
          if (hasDatabaseUrl()) {
            await recordReviewCompleted(payload.installationId, payload.reviewId);
            await recordTokenUsage(payload.installationId, payload.reviewId, result.usage);
          } else {
            logDatabaseSkip("record_usage", payload);
          }
        }
      } catch (usageErr) {
        captureException(usageErr, {
          properties: {
            op: "record_usage",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
          },
        });
      }

      return { ok: true, findings: result.findings.length };
    } catch (err) {
      const failureStage = classifyReviewWorkerFailure(err);
      const publicError = new Error(publicReviewErrorMessage());
      captureException(publicError, {
        properties: {
          op: "review_cli",
          repoFullName: payload.repoFullName,
          pullNumber: payload.pullNumber,
          headSha: payload.headSha,
          modelUsed: reviewModelUsed,
          errorClass: err instanceof Error ? err.name : typeof err,
          workerStage: failureStage,
        },
      });

      try {
        await markReviewFailed(payload, failureStage);
      } catch (dbErr) {
        captureException(dbErr, {
          properties: {
            op: "update_review_failed",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
            workerStage: failureStage,
          },
        });
      }

      try {
        await completeCheckRunFailed(payload, failureStage);
      } catch (checkRunErr) {
        captureException(new Error("postil review check-run failure patch failed"), {
          properties: {
            op: "emergency_complete_check_run",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
            errorClass: checkRunErr instanceof Error ? checkRunErr.name : typeof checkRunErr,
            workerStage: failureStage,
          },
        });
      }

      track("system", "review_failed", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        headSha: payload.headSha,
        error: publicReviewErrorMessage(),
        errorClass: err instanceof Error ? err.name : "unknown",
        workerStage: failureStage,
        modelUsed: reviewModelUsed,
        installationHash,
      });

      throw publicError;
    }
  },
});

export async function enqueueReviewPullRequest(payload: ReviewPayload, idempotencyKey: string) {
  return tasks.trigger<typeof reviewPullRequest>(
    reviewPullRequest.id,
    payload,
    { idempotencyKey },
    { clientConfig: triggerClientConfig() },
  );
}
