import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger, task, tasks } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";
import { Octokit } from "@octokit/rest";
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
const CLI_LOG_SNIPPET_LIMIT = 2_000;

function safePayload(payload: ReviewPayload): Omit<ReviewPayload, "encryptedInstallationToken"> {
  const { encryptedInstallationToken: _encryptedInstallationToken, ...safe } = payload;
  return safe;
}

function requireTriggerSecretKey(): string {
  const secret = env.reviewTokenSecret?.trim();
  if (!secret) {
    throw new Error("REVIEW_TOKEN_SECRET must be set to decrypt review installation tokens");
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

async function completeCheckRunFailed(payload: ReviewPayload): Promise<void> {
  if (!payload.checkRunId) return;
  const octokit = await reviewOctokit(payload);
  const [owner, repo] = payload.repoFullName.split("/");
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: payload.checkRunId,
    status: "completed",
    conclusion: "failure",
    completed_at: new Date().toISOString(),
    output: {
      title: "Postil Review",
      summary: publicReviewErrorMessage(),
      text: publicReviewErrorMessage(),
    },
  });
}

async function markReviewFailed(payload: ReviewPayload): Promise<void> {
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
      errorMessage: publicReviewErrorMessage(),
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
      decryptedInstallationToken(payload) ?? (await mintInstallationToken(payload.installationId));
    await writeFile(
      configPath,
      JSON.stringify({
        githubToken: installationToken,
        openrouterApiKey: env.OPENROUTER_API_KEY,
        repo: payload.repoFullName,
        pr: payload.pullNumber,
        sha: payload.headSha,
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
      const diagnostics = cliFailureDiagnostics(err);
      try {
        const result = reviewEnvelope.parse(JSON.parse(await readFile(outputPath, "utf8")));
        if (isExpectedReviewResultExit(err)) {
          logger.info("accepted review CLI output after nonzero exit", {
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
            headSha: payload.headSha,
            findings: result.findings.length,
            ...diagnostics,
          });
          return result;
        }
      } catch {
        // Preserve the original CLI failure when no valid review envelope exists.
      }
      logger.info("review CLI failed", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        headSha: payload.headSha,
        ...diagnostics,
      });
      throw err;
    }
    return reviewEnvelope.parse(JSON.parse(await readFile(outputPath, "utf8")));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

function isExpectedReviewResultExit(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === 1;
}

function cliFailureDiagnostics(err: unknown): {
  exitCode?: unknown;
  signal?: unknown;
  killed?: unknown;
  timedOut?: unknown;
  stdout?: string;
  stderr?: string;
} {
  if (typeof err !== "object" || err === null) return {};
  const record = err as Record<string, unknown>;
  return {
    exitCode: record.code,
    signal: record.signal,
    killed: record.killed,
    timedOut: record.timedOut,
    stdout: logSnippet(record.stdout),
    stderr: logSnippet(record.stderr),
  };
}

function logSnippet(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return redactCliOutput(value).slice(0, CLI_LOG_SNIPPET_LIMIT);
}

function redactCliOutput(value: string): string {
  return value
    .replace(/ghs_[A-Za-z0-9_]+/g, "[redacted-github-token]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted-github-token]")
    .replace(/tr_(?:pat|prod|dev|stg)_[A-Za-z0-9_]+/g, "[redacted-trigger-token]")
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "[redacted-openrouter-token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted-token]");
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
      const publicError = new Error(publicReviewErrorMessage());
      captureException(publicError, {
        properties: {
          op: "review_cli",
          repoFullName: payload.repoFullName,
          pullNumber: payload.pullNumber,
          headSha: payload.headSha,
          modelUsed: reviewModelUsed,
          errorClass: err instanceof Error ? err.name : typeof err,
        },
      });

      try {
        await markReviewFailed(payload);
      } catch (dbErr) {
        captureException(dbErr, {
          properties: {
            op: "update_review_failed",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
          },
        });
      }

      try {
        await completeCheckRunFailed(payload);
      } catch (checkRunErr) {
        captureException(new Error("postil review check-run failure patch failed"), {
          properties: {
            op: "emergency_complete_check_run",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
            errorClass: checkRunErr instanceof Error ? checkRunErr.name : typeof checkRunErr,
          },
        });
      }

      track("system", "review_failed", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        headSha: payload.headSha,
        error: publicReviewErrorMessage(),
        errorClass: err instanceof Error ? err.name : "unknown",
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
