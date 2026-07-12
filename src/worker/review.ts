import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { validateApiBase } from "@/lib/api-base";
import { calculateUsageCostCentsForModel } from "@/lib/billing-credits";
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
import {
  materializeOrgConfig,
  materializeRepoConfig,
  type OrgReviewConfig,
} from "@/lib/github/contents";
import { configuredPublicOrigin } from "@/lib/oauth";
import type { ReviewJobPayload } from "@/lib/queue";
import { redactAndTruncate, redactSecrets } from "@/lib/redact";

export const REVIEW_DEADLINE_MS = 10 * 60 * 1000;
// Match postil-cli's hosted profile: a normal slow review gets up to seven
// minutes, the shared LLM deadline keeps two minutes available for a fallback
// or scorer, and the worker retains one minute for process and persistence work.
const HOSTED_LLM_REQUEST_TIMEOUT_SECS = "420";
const HOSTED_LLM_TOTAL_TIMEOUT_SECS = "540";

const CACHE_DIR = optionalEnv("POSTIL_CACHE_DIR", ".cache") as string;

class OperationalError extends Error {}

interface CliEnvConfig {
  apiBase: string;
  apiKey: string | undefined;
  model: string | undefined;
  modelCascade: string | undefined;
}

export function buildCliEnv(
  llm: CliEnvConfig,
  baseEnv: Record<string, string> = {},
): Record<string, string> {
  const cliEnv: Record<string, string> = {
    ...baseEnv,
    POSTIL_API_BASE: llm.apiBase,
    POSTIL_LLM_REQUEST_TIMEOUT_SECS: optionalEnv(
      "POSTIL_LLM_REQUEST_TIMEOUT_SECS",
      HOSTED_LLM_REQUEST_TIMEOUT_SECS,
    ) as string,
    POSTIL_LLM_TOTAL_TIMEOUT_SECS: optionalEnv(
      "POSTIL_LLM_TOTAL_TIMEOUT_SECS",
      HOSTED_LLM_TOTAL_TIMEOUT_SECS,
    ) as string,
  };
  if (llm.apiKey) {
    cliEnv.MODEL_API_KEY = llm.apiKey;
    cliEnv.POSTIL_API_KEY = llm.apiKey;
  }
  if (llm.model) cliEnv.REVIEW_MODEL = llm.model;
  if (llm.modelCascade) cliEnv.REVIEW_MODEL_CASCADE = llm.modelCascade;
  return cliEnv;
}

/** Resolve LLM config: org BYO settings win, env defaults otherwise. */
export async function resolveLlmConfig(orgId: number | null): Promise<CliEnvConfig> {
  const defaults: CliEnvConfig = {
    apiBase: optionalEnv("POSTIL_API_BASE", "https://openrouter.ai/api/v1") as string,
    apiKey:
      optionalEnv("MODEL_API_KEY") ??
      optionalEnv("POSTIL_API_KEY") ??
      optionalEnv("OPENROUTER_API_KEY"),
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
  if (!settings.apiKeyCiphertext) return defaults;
  const apiKey = unseal(Buffer.from(settings.apiKeyCiphertext), getSealingKey());
  // Internal-network guard at the worker boundary: rows predating write-time
  // validation must not reach the spawned CLI as POSTIL_API_BASE.
  if (settings.apiBase) await validateApiBase(settings.apiBase);
  return {
    apiBase: settings.apiBase ?? defaults.apiBase,
    apiKey,
    model: settings.model ?? defaults.model,
    modelCascade: settings.modelCascade ?? defaults.modelCascade,
  };
}

/** Load hosted review artifacts independently of the organization's BYO key. */
export async function resolveOrgReviewConfig(
  orgId: number | null,
): Promise<OrgReviewConfig | null> {
  if (orgId == null) return null;
  const db = getDb();
  const rows = await db
    .select({
      configYaml: schema.orgSettings.configYaml,
      guardrailsMd: schema.orgSettings.guardrailsMd,
      contentPolicyMd: schema.orgSettings.contentPolicyMd,
    })
    .from(schema.orgSettings)
    .where(eq(schema.orgSettings.orgId, orgId))
    .limit(1);
  return rows[0] ?? null;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CliObservers {
  onStderrLine?: (line: string) => void;
}

const REVIEW_LOG_FLUSH_MS = 1_000;
const REVIEW_LOG_BATCH_SIZE = 50;
export const REVIEW_LOG_MAX_LINES = 2_000;
const REVIEW_LOG_LINE_MAX_CHARS = 10_000;

/** Buffered per-review writer. Storage failures never fail the review itself. */
export class ReviewLogWriter {
  private readonly pending: Array<typeof schema.reviewLogs.$inferInsert> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private writeChain: Promise<void> = Promise.resolve();
  private nextSeq = 1;
  private stopped = false;
  private sensitiveValues: string[] = [];

  constructor(private readonly reviewId: number) {
    this.timer = setInterval(() => void this.flush(), REVIEW_LOG_FLUSH_MS);
    this.timer.unref?.();
  }

  setSensitiveValues(values: string[]): void {
    this.sensitiveValues = values;
  }

  line(value: unknown): void {
    if (this.stopped) return;
    let line: string;
    if (this.nextSeq === REVIEW_LOG_MAX_LINES) {
      line = `[log truncated after ${REVIEW_LOG_MAX_LINES - 1} lines]`;
      this.stopped = true;
    } else {
      line = redactAndTruncate(String(value), REVIEW_LOG_LINE_MAX_CHARS, this.sensitiveValues);
    }
    this.pending.push({
      reviewId: this.reviewId,
      seq: this.nextSeq,
      at: new Date(),
      line,
    });
    this.nextSeq += 1;
    if (this.pending.length >= REVIEW_LOG_BATCH_SIZE) void this.flush();
  }

  async flush(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length > 0) {
      this.writeChain = this.writeChain.then(async () => {
        try {
          await getDb().insert(schema.reviewLogs).values(batch);
        } catch (err) {
          console.error(
            `review ${this.reviewId}: could not persist log batch: ${redactSecrets(err, this.sensitiveValues)}`,
          );
        }
      });
    }
    await this.writeChain;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}

function createLineObserver(onLine: ((line: string) => void) | undefined) {
  let remainder = "";
  const decoder = new TextDecoder();
  return {
    push(chunk: Buffer) {
      if (!onLine) return;
      const text = remainder + decoder.decode(chunk, { stream: true });
      const parts = text.split("\n");
      remainder = parts.pop() ?? "";
      for (const part of parts) onLine(part.endsWith("\r") ? part.slice(0, -1) : part);
    },
    end() {
      if (!onLine) return;
      remainder += decoder.decode();
      if (remainder.length > 0) onLine(remainder.endsWith("\r") ? remainder.slice(0, -1) : remainder);
      remainder = "";
    },
  };
}

export function runCli(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
  observers: CliObservers = {},
): Promise<CliResult> {
  const bin = optionalEnv("POSTIL_BIN", "postil") as string;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stderrLines = createLineObserver(observers.onStderrLine);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, REVIEW_DEADLINE_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      stderrLines.push(chunk);
    });
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
      stderrLines.end();
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
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
export async function runReviewJob(
  payload: ReviewJobPayload,
  timing: { queuedAt: Date; startedAt: Date } = {
    queuedAt: new Date(),
    startedAt: new Date(),
  },
): Promise<void> {
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
      .leftJoin(schema.organizations, eq(schema.installations.orgId, schema.organizations.id))
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
      queuedAt: timing.queuedAt,
      startedAt: timing.startedAt,
    })
    .returning({ id: schema.reviews.id, publicId: schema.reviews.publicId });
  const reviewId = inserted[0]?.id;
  const publicId = inserted[0]?.publicId;
  if (reviewId === undefined || !publicId) throw new Error("review insert returned no row");

  const reviewLog = new ReviewLogWriter(reviewId);
  reviewLog.line(
    `review queued at ${timing.queuedAt.toISOString()} -> worker claimed at ${timing.startedAt.toISOString()}`,
  );

  let token: string | undefined;
  let advisoryCheckRunId: number | undefined;
  let gateCheckRunId: number | undefined;
  let baselinePath: string | undefined;
  let workDir: string | undefined;
  let sensitiveValues: string[] = [];

  try {
    token = await getInstallationToken(payload.installationId);
    sensitiveValues = [token];
    reviewLog.setSensitiveValues(sensitiveValues);
    const superseded = await supersedeActiveReviews({
      repositoryId: repository.id,
      prNumber: payload.prNumber,
      newHeadSha: payload.headSha,
      repoFullName: payload.repoFullName,
      token,
      excludeReviewId: reviewId,
    });
    if (superseded > 0) reviewLog.line(`superseded ${superseded} earlier active review(s)`);

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
    reviewLog.line("forge check-runs created");

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
      // Absolute: the CLI resolves --baseline against its own cwd, which is
      // the per-review work dir below, not the worker's.
      args.push("--since-sha", baseline.headSha, "--baseline", resolve(baselinePath));
    }
    args.push("--output-json");

    // Materialize the repo's .postil config (default branch) into a fresh
    // per-review directory and run the CLI there, so repo-level config works
    // hosted exactly as it does locally. See lib/github/contents.ts for the
    // trust model (default branch only, never the PR head).
    workDir = resolve(CACHE_DIR, "workdirs", `review-${reviewId}`);
    await mkdir(workDir, { recursive: true });
    const repoConfigFiles = await materializeRepoConfig(
      token,
      payload.repoFullName,
      workDir,
    );
    if (repoConfigFiles.length > 0) {
      console.log(
        `review ${reviewId}: using repo config from ${payload.repoFullName} (${repoConfigFiles.join(", ")})`,
      );
    }
    const orgConfigFiles = await materializeOrgConfig(
      workDir,
      repoConfigFiles,
      await resolveOrgReviewConfig(installation.orgId),
    );
    if (orgConfigFiles.length > 0) {
      console.log(
        `review ${reviewId}: using hosted organization config (${orgConfigFiles
          .map((file) => file.slice(4))
          .join(", ")})`,
      );
    }
    const configFiles = [...repoConfigFiles, ...orgConfigFiles];
    reviewLog.line(
      `configuration materialized (${configFiles.length > 0 ? configFiles.join(", ") : "no overrides"})`,
    );

    const llm = await resolveLlmConfig(installation.orgId);
    sensitiveValues = [token, llm.apiKey].filter((value): value is string => Boolean(value));
    reviewLog.setSensitiveValues(sensitiveValues);
    const publicOrigin = configuredPublicOrigin();
    const detailsUrl =
      publicOrigin && installation.orgSlug
        ? new URL(
            `/orgs/${encodeURIComponent(installation.orgSlug)}/runs/${publicId}`,
            publicOrigin,
          ).toString()
        : undefined;
    const cliEnv = buildCliEnv(llm, {
      GITHUB_TOKEN: token,
      ...(detailsUrl ? { POSTIL_DETAILS_URL: detailsUrl } : {}),
    });

    reviewLog.line("postil CLI spawned");
    const result = await runCli(args, cliEnv, workDir, {
      onStderrLine: (line) => reviewLog.line(`[stderr] ${line}`),
    });
    reviewLog.line(
      `postil CLI exited with code ${result.exitCode}${result.timedOut ? " after timeout" : ""}`,
    );

    if (result.timedOut) {
      throw new OperationalError(`review exceeded ${REVIEW_DEADLINE_MS / 60000} minute deadline`);
    }
    // Exit 0 = clean/below gate, 1 = gate-failing findings; both produce a
    // valid envelope. 2 (or anything else) is an operational error.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const stderr = redactAndTruncate(result.stderr, 500, sensitiveValues);
      throw new OperationalError(
        `postil CLI exited with code ${result.exitCode}: ${stderr}`,
      );
    }

    const ingested = ingestEnvelope(result.stdout);
    reviewLog.line(
      `envelope ingested (${Buffer.byteLength(result.stdout)} bytes, ${ingested.envelope.findings.length} findings, gate ${ingested.gateFailing ? "failing" : "passing"})`,
    );
    reviewLog.line("forge check-runs updated by the CLI");

    // Guard on status so a completion racing a superseding push or watchdog
    // cannot flap the row back to completed or attribute usage to a run that
    // no longer owns the result. The CLI owns the success-path check-runs.
    const completedRows = await db
      .update(schema.reviews)
      .set({
        status: "completed",
        envelope: ingested.envelope,
        configFiles,
        silent: ingested.silent,
        engineGateFailing: ingested.gateFailing,
        gateFailing: ingested.gateFailing,
        finishedAt: new Date(),
      })
      .where(and(eq(schema.reviews.id, reviewId), eq(schema.reviews.status, "running")))
      .returning({ id: schema.reviews.id });

    if (completedRows.length > 0) {
      await db.insert(schema.usageEvents).values({
        orgId: installation.orgId,
        repositoryId: repository.id,
        reviewId,
        promptTokens: ingested.promptTokens,
        completionTokens: ingested.completionTokens,
        modelUsed: ingested.modelUsed,
        costCents: calculateUsageCostCentsForModel(
          ingested.modelUsed,
          ingested.promptTokens,
          ingested.completionTokens,
        ),
      });
    } else {
      const terminal = (
        await db
          .select({ status: schema.reviews.status })
          .from(schema.reviews)
          .where(eq(schema.reviews.id, reviewId))
          .limit(1)
      )[0];
      if (terminal?.status === "stale") {
        // A superseding webhook may have neutralized the checks while this
        // CLI was still running. The CLI can PATCH them afterward, so make
        // neutral the final forge state once the old process exits.
        await neutralizeSupersededCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId ?? null,
          gateCheckRunId ?? null,
          "superseded by a newer review",
        );
        reviewLog.line("forge check-runs restored to neutral after supersession");
      }
      console.warn(`review ${reviewId} completed after it was already superseded or failed`);
    }
  } catch (err) {
    const message = redactSecrets(err, sensitiveValues);
    reviewLog.line(`review failed: ${message}`);
    const failedRows = await db
      .update(schema.reviews)
      .set({
        status: "failed",
        errorMessage: redactAndTruncate(message, 2000, sensitiveValues),
        finishedAt: new Date(),
      })
      .where(and(eq(schema.reviews.id, reviewId), eq(schema.reviews.status, "running")))
      .returning({ id: schema.reviews.id });
    // Without a token there are no check-runs to complete (creation is the
    // first tokened call); with one, fail them closed - unless the watchdog
    // already claimed this review and completed them itself (0 rows above).
    if (token && failedRows.length > 0) {
      await failCheckRuns(token, payload.repoFullName, advisoryCheckRunId, gateCheckRunId, message);
      reviewLog.line("forge check-runs updated for review failure");
    }
    throw err;
  } finally {
    if (baselinePath) await rm(baselinePath, { force: true }).catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    await reviewLog.close();
  }
}

interface SupersedeActiveReviewsInput {
  repositoryId: number;
  prNumber: number;
  newHeadSha: string;
  repoFullName: string;
  excludeReviewId?: number;
  onlyDifferentHead?: boolean;
  token?: string;
  githubInstallationId?: number;
}

/** Mark active reviews stale and neutralize every recorded forge check-run. */
export async function supersedeActiveReviews(
  input: SupersedeActiveReviewsInput,
): Promise<number> {
  const db = getDb();
  const active = await db
    .select({
      id: schema.reviews.id,
      advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
      gateCheckRunId: schema.reviews.gateCheckRunId,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.repositoryId, input.repositoryId),
        eq(schema.reviews.prNumber, input.prNumber),
        inArray(schema.reviews.status, ["queued", "running"]),
        input.excludeReviewId === undefined
          ? undefined
          : ne(schema.reviews.id, input.excludeReviewId),
        input.onlyDifferentHead ? ne(schema.reviews.headSha, input.newHeadSha) : undefined,
      ),
    );
  if (active.length === 0) return 0;

  let token = input.token;
  if (
    !token &&
    active.some((review) => review.advisoryCheckRunId != null || review.gateCheckRunId != null)
  ) {
    if (input.githubInstallationId === undefined) {
      throw new Error("cannot complete superseded check-runs without an installation id");
    }
    token = await getInstallationToken(input.githubInstallationId);
  }

  const message = `superseded by a newer review of ${input.newHeadSha}`;
  let superseded = 0;
  for (const review of active) {
    const changed = await db
      .update(schema.reviews)
      .set({ status: "stale", finishedAt: new Date() })
      .where(
        and(
          eq(schema.reviews.id, review.id),
          inArray(schema.reviews.status, ["queued", "running"]),
        ),
      )
      .returning({ id: schema.reviews.id });
    if (changed.length === 0) continue;
    superseded += 1;
    if (token) {
      await neutralizeSupersededCheckRuns(
        token,
        input.repoFullName,
        review.advisoryCheckRunId,
        review.gateCheckRunId,
        message,
      );
    }
  }
  return superseded;
}

async function neutralizeSupersededCheckRuns(
  token: string,
  repoFullName: string,
  advisoryCheckRunId: number | null,
  gateCheckRunId: number | null,
  message: string,
): Promise<void> {
  for (const checkRunId of [gateCheckRunId, advisoryCheckRunId]) {
    if (checkRunId == null) continue;
    await completeCheckRun(
      token,
      repoFullName,
      checkRunId,
      "neutral",
      "Review superseded",
      message,
    ).catch((err) =>
      console.error(
        `failed to complete superseded check-run ${checkRunId}: ${redactSecrets(err, [token])}`,
      ),
    );
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
  const summary = `Postil could not complete this review: ${redactAndTruncate(message, 400, [
    token,
  ])}`;
  if (gateCheckRunId != null) {
    await completeCheckRun(
      token,
      repoFullName,
      gateCheckRunId,
      "failure",
      "Review did not complete",
      `${summary}\n\nThe gate fails closed: an unreviewed head is not a passing head. Re-run by pushing or re-requesting the check.`,
    ).catch((e) => console.error(`failed to complete gate check-run: ${redactSecrets(e, [token])}`));
  }
  if (advisoryCheckRunId != null) {
    await completeCheckRun(
      token,
      repoFullName,
      advisoryCheckRunId,
      "neutral",
      "Review did not complete",
      summary,
    ).catch((e) =>
      console.error(`failed to complete advisory check-run: ${redactSecrets(e, [token])}`),
    );
  }
}
