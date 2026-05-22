import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { auth, logger, task } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { mintInstallationToken } from "@/lib/github";
import { captureException, hashInstallationId, track } from "@/lib/posthog";
import { recordReviewCompleted, recordTokenUsage } from "@/lib/usage";
import {
  type ReviewEnvelope,
  type ReviewPayload,
  reviewEnvelope,
  reviewPayload,
} from "./review-types";

const execFile = promisify(execFileCb);
type CheckRunClient = Pick<Octokit, "request">;

let triggerConfigured = false;

function ensureTriggerConfigured(): void {
  if (triggerConfigured) return;
  if (!env.triggerApiKey) {
    throw new Error("Trigger API token must be set to dispatch review tasks");
  }

  auth.configure({
    baseURL: env.TRIGGER_API_URL,
    accessToken: env.triggerApiKey,
  });
  triggerConfigured = true;
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

function createRepositoryCheckRunClient(): CheckRunClient | null {
  if (!env.GITHUB_PAT) return null;
  return new Octokit({ auth: env.GITHUB_PAT });
}

async function completeCheckRunFailed(payload: ReviewPayload): Promise<void> {
  if (!payload.checkRunId) return;
  const octokit = createRepositoryCheckRunClient();
  if (!octokit) throw new Error("review check client unavailable");
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
    const installationToken = await mintInstallationToken(payload.installationId);
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
      });
    } catch (err) {
      try {
        const result = reviewEnvelope.parse(JSON.parse(await readFile(outputPath, "utf8")));
        if (isExpectedFindingsExit(err) && result.findings.length > 0) {
          // The CLI owns check-run completion through checkRunId before exiting for findings.
          return result;
        }
      } catch {
        // Preserve the original CLI failure when no valid review envelope exists.
      }
      throw err;
    }
    return reviewEnvelope.parse(JSON.parse(await readFile(outputPath, "utf8")));
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
    logger.info("starting review", { payload });
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

      if (payload.reviewId) {
        try {
          const db = getDb();
          await db
            .update(schema.reviews)
            .set({
              status: "completed",
              result,
              completedAt: new Date(),
            })
            .where(eq(schema.reviews.id, payload.reviewId));
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
          await recordReviewCompleted(payload.installationId, payload.reviewId);
          await recordTokenUsage(payload.installationId, payload.reviewId, result.usage);
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
  ensureTriggerConfigured();
  return reviewPullRequest.trigger(payload, { idempotencyKey });
}
