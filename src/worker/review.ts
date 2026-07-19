import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { validateApiBase } from "@/lib/api-base";
import { calculateUsageCostMicrosForModel } from "@/lib/billing-credits";
import {
  parseApiFormat,
  validateAdditionalAuthHeader,
  validateAdditionalAuthValue,
  type ApiFormat,
} from "@/lib/byok-provider";
import {
  canProcessRepositoryInference,
  providerModeMatchesRepositoryAccess,
} from "@/lib/private-repository-entitlement";
import { getSealingKey, unseal } from "@/lib/crypto/seal";
import { getDb, getPool, schema } from "@/lib/db";
import { hostedInferenceAvailable, optionalEnv } from "@/lib/env";
import {
  classifyOperationalModelIncidents,
  ingestEnvelope,
} from "@/lib/envelope";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRepositorySummary } from "@/lib/github/installation-sync";
import {
  ADVISORY_CHECK_NAME,
  AmbiguousCheckRunCreationError,
  CheckRunPublicationError,
  GATE_CHECK_NAME,
  checkRunExternalId,
  completeCheckRun,
  completeExpectedCheckRun,
  createCheckRun,
  findCheckRunByExternalId,
  getPullRequestReviewContext,
  verifyCompletedCheckRun,
  type ExpectedCheckRunIdentity,
} from "@/lib/github/checks";
import {
  materializeOrgConfig,
  materializeRepoConfig,
  materializeSharedConfig,
  buildConfigProvenance,
  missingRepositoryConfigSlots,
  type ConfigProvenanceEntry,
  type OrgReviewConfig,
} from "@/lib/github/contents";
import {
  createOwnerConfigStore,
  resolveOwnerGithubConfig,
} from "@/lib/github/owner-config";
import { configuredPublicOrigin } from "@/lib/oauth";
import {
  reconcileConservativeHostedReviewSpend,
  reconcileHostedReviewSpendFromReceipt,
  releaseHostedReviewSpend,
  reserveHostedReviewSpend,
} from "@/lib/hosted-usage-reservations";
import { claimPausedHostedReview } from "@/lib/hosted-review-pause";
import { withoutOrgModelConfig } from "@/lib/org-review-config";
import type { CheckRunCleanupJobPayload, ReviewJobPayload } from "@/lib/queue";
import { normalizeReviewTriggerContext } from "@/lib/review-trigger";
import { redactAndTruncate, redactSecrets } from "@/lib/redact";
import {
  persistReviewCompletion,
  type ReviewCompletionInput,
} from "@/lib/review-completion";
import { discoverPreventionCommands } from "@/lib/review-guidance";
import { HOSTED_REVIEW_UNAVAILABLE_MESSAGE } from "@/lib/review-outcome";
import { shouldSendPreventionHint } from "@/lib/review-prevention-db";
import {
  reportOperationalModelIncident,
  type ObservabilityProcessGroup,
} from "@/lib/server-observability";

export const REVIEW_DEADLINE_MS = 10 * 60 * 1000;
// Match postil-cli's hosted profile: a normal slow review gets up to seven
// minutes, the shared LLM deadline keeps two minutes available for a fallback
// or scorer, and the worker retains one minute for process and persistence work.
const HOSTED_LLM_REQUEST_TIMEOUT_SECS = "420";
const HOSTED_LLM_TOTAL_TIMEOUT_SECS = "540";

const CACHE_DIR = optionalEnv("POSTIL_CACHE_DIR", ".cache") as string;

class OperationalError extends Error {}

export class WorkerShutdownError extends OperationalError {
  constructor() {
    super("review interrupted by worker shutdown");
    this.name = "WorkerShutdownError";
  }
}

interface ExpectedFailureCheckRuns {
  advisory?: ExpectedCheckRunIdentity;
  gate?: ExpectedCheckRunIdentity;
  publicationIncomplete?: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function translateWorkerAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (signal?.aborted && isAbortError(error)) throw new WorkerShutdownError();
    throw error;
  }
}

interface CliEnvConfig {
  byok: boolean;
  apiBase: string;
  apiFormat: ApiFormat;
  apiKey: string | undefined;
  apiAuthHeader: string | undefined;
  apiAuthValue: string | undefined;
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
    POSTIL_API_FORMAT: llm.apiFormat,
    // Hosted inference always uses the roster baked into the pinned CLI.
    // Repository model settings are accepted only when the organization has
    // supplied its own provider credentials.
    POSTIL_HOSTED_MODE: llm.byok ? "0" : "1",
    // Provisional admission is a managed-hosted deployment choice. Always
    // shadow the worker environment so BYOK children cannot inherit it.
    POSTIL_PROVISIONAL_HOSTED_ROSTER: llm.byok
      ? "0"
      : (optionalEnv("POSTIL_PROVISIONAL_HOSTED_ROSTER", "0") as string),
    // Always shadow process.env. A BYOK endpoint without additional auth must
    // never inherit the hosted gateway credential when runCli merges envs.
    POSTIL_ENDPOINT_AUTH_HEADER: llm.apiAuthHeader ?? "",
    POSTIL_ENDPOINT_AUTH_VALUE: llm.apiAuthValue ?? "",
    // runCli inherits process.env. Shadow every supported or common provider
    // credential alias so a BYOK child can receive only its sealed org key.
    MODEL_API_KEY: "",
    POSTIL_API_KEY: "",
    OPENROUTER_API_KEY: "",
    LLM_API_KEY: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    // This is per-review policy, never a deployment-wide toggle inherited by
    // every child process.
    POSTIL_PREVENTION_HINT: baseEnv.POSTIL_PREVENTION_HINT === "1" ? "1" : "0",
    POSTIL_PREVENTION_COMMANDS_JSON:
      baseEnv.POSTIL_PREVENTION_COMMANDS_JSON ?? "[]",
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
export async function resolveLlmConfig(
  orgId: number | null,
): Promise<CliEnvConfig> {
  const configuredFormat = optionalEnv(
    "POSTIL_API_FORMAT",
    "openai-compatible",
  ) as string;
  const defaultFormat = parseApiFormat(configuredFormat);
  if (!defaultFormat)
    throw new Error("POSTIL_API_FORMAT must be openai-compatible or anthropic");
  const defaultAuthHeader = optionalEnv("POSTIL_ENDPOINT_AUTH_HEADER");
  const defaultAuthValue = optionalEnv("POSTIL_ENDPOINT_AUTH_VALUE");
  if (Boolean(defaultAuthHeader) !== Boolean(defaultAuthValue)) {
    throw new Error(
      "POSTIL_ENDPOINT_AUTH_HEADER and POSTIL_ENDPOINT_AUTH_VALUE must be set together",
    );
  }
  if (defaultAuthHeader)
    validateAdditionalAuthHeader(defaultAuthHeader, defaultFormat);
  if (defaultAuthValue) validateAdditionalAuthValue(defaultAuthValue);
  const defaults: CliEnvConfig = {
    byok: false,
    apiBase: optionalEnv(
      "POSTIL_API_BASE",
      "https://openrouter.ai/api/v1",
    ) as string,
    apiFormat: defaultFormat,
    apiKey:
      optionalEnv("MODEL_API_KEY") ??
      optionalEnv("POSTIL_API_KEY") ??
      optionalEnv("OPENROUTER_API_KEY"),
    apiAuthHeader: defaultAuthHeader,
    apiAuthValue: defaultAuthValue,
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
  const apiKey = unseal(
    Buffer.from(settings.apiKeyCiphertext),
    getSealingKey(),
  );
  // Internal-network guard at the worker boundary: rows predating write-time
  // validation must not reach the spawned CLI as POSTIL_API_BASE.
  if (settings.apiBase) await validateApiBase(settings.apiBase);
  const apiFormat = parseApiFormat(settings.apiFormat ?? "openai-compatible");
  if (!apiFormat) throw new Error("stored BYOK API interface is invalid");
  const hasAuthHeader = Boolean(settings.apiAuthHeaderCiphertext);
  const hasAuthValue = Boolean(settings.apiAuthValueCiphertext);
  if (hasAuthHeader !== hasAuthValue) {
    throw new Error("stored BYOK additional authentication is incomplete");
  }
  const apiAuthHeader = settings.apiAuthHeaderCiphertext
    ? unseal(Buffer.from(settings.apiAuthHeaderCiphertext), getSealingKey())
    : undefined;
  const apiAuthValue = settings.apiAuthValueCiphertext
    ? unseal(Buffer.from(settings.apiAuthValueCiphertext), getSealingKey())
    : undefined;
  if (apiAuthHeader) validateAdditionalAuthHeader(apiAuthHeader, apiFormat);
  if (apiAuthValue) validateAdditionalAuthValue(apiAuthValue);
  return {
    byok: true,
    apiBase: settings.apiBase ?? defaults.apiBase,
    apiFormat,
    apiKey,
    apiAuthHeader,
    apiAuthValue,
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
  const row = rows[0];
  return row
    ? { ...row, configYaml: withoutOrgModelConfig(row.configYaml) }
    : null;
}

/** Shared owner config defaults on even when the organization has no settings row. */
export async function resolveSharedConfigEnabled(
  orgId: number | null,
): Promise<boolean> {
  if (orgId == null) return false;
  const row = (
    await getDb()
      .select({ enabled: schema.orgSettings.sharedConfigEnabled })
      .from(schema.orgSettings)
      .where(eq(schema.orgSettings.orgId, orgId))
      .limit(1)
  )[0];
  return row?.enabled ?? true;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CliObservers {
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

const POSTIL_CLI_VERSION_TIMEOUT_MS = 3_000;
const POSTIL_CLI_VERSION_OUTPUT_MAX_BYTES = 256;
const POSTIL_CLI_VERSION_PATTERN =
  /^postil\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const postilCliVersionCache = new Map<string, Promise<string>>();

/** Probe the immutable worker binary without forwarding process credentials. */
export function probePostilCliVersion(
  executable: string,
  timeoutMs = POSTIL_CLI_VERSION_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const safeEnvironment = (
      process.env.PATH ? { PATH: process.env.PATH } : {}
    ) as NodeJS.ProcessEnv;
    const child = spawn(executable, ["--version"], {
      env: safeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const reject = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new OperationalError(message));
    };
    const resolve = (version: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(version);
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(`postil CLI version probe timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > POSTIL_CLI_VERSION_OUTPUT_MAX_BYTES) {
        child.kill("SIGKILL");
        reject("postil CLI version probe exceeded its output limit");
        return;
      }
      stdout += chunk.toString();
    });
    child.stderr.resume();
    child.on("error", () => {
      reject("failed to start postil CLI version probe");
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      if (exitCode !== 0) {
        reject(
          `postil CLI version probe exited with code ${exitCode ?? "unknown"}`,
        );
        return;
      }
      const match = POSTIL_CLI_VERSION_PATTERN.exec(stdout.trim());
      if (!match?.[1]) {
        reject("postil CLI version probe returned unrecognized output");
        return;
      }
      resolve(match[1]);
    });
  });
}

export async function postilCliVersionLogLine(): Promise<string> {
  const executable = optionalEnv("POSTIL_BIN", "postil") as string;
  let version = postilCliVersionCache.get(executable);
  if (!version) {
    // A broken or missing binary should not add the full probe timeout to every
    // queued review. Cache the safe sentinel just like a successful version.
    version = probePostilCliVersion(executable).catch(() => "unavailable");
    postilCliVersionCache.set(executable, version);
  }
  return `postil CLI version ${await version}`;
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
      line = redactAndTruncate(
        String(value),
        REVIEW_LOG_LINE_MAX_CHARS,
        this.sensitiveValues,
      );
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
      for (const part of parts)
        onLine(part.endsWith("\r") ? part.slice(0, -1) : part);
    },
    end() {
      if (!onLine) return;
      remainder += decoder.decode();
      if (remainder.length > 0)
        onLine(remainder.endsWith("\r") ? remainder.slice(0, -1) : remainder);
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
    let interrupted = false;
    let settled = false;
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
    const stderrLines = createLineObserver(observers.onStderrLine);
    const cleanup = () => {
      clearTimeout(timer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      observers.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled || interrupted) return;
      interrupted = true;
      child.kill("SIGTERM");
      abortKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      abortKillTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, REVIEW_DEADLINE_MS);
    if (observers.signal?.aborted) abort();
    else observers.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      stderrLines.push(chunk);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new OperationalError(
          `failed to spawn postil CLI (${bin}): ${err.message}. Set POSTIL_BIN or put 'postil' on PATH.`,
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      stderrLines.end();
      if (interrupted) {
        reject(new WorkerShutdownError());
        return;
      }
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

function throwIfWorkerStopping(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorkerShutdownError();
  }
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
  observabilityProcessGroup: ObservabilityProcessGroup = "worker",
  signal?: AbortSignal,
  onPublicationStarted?: () => void,
): Promise<void> {
  throwIfWorkerStopping(signal);
  const db = getDb();

  const installation = (
    await db
      .select({
        id: schema.installations.id,
        orgId: schema.installations.orgId,
        orgSlug: schema.organizations.slug,
        githubOrgId: schema.organizations.githubOrgId,
        suspended: schema.installations.suspended,
      })
      .from(schema.installations)
      .leftJoin(
        schema.organizations,
        eq(schema.installations.orgId, schema.organizations.id),
      )
      .where(
        eq(schema.installations.githubInstallationId, payload.installationId),
      )
      .limit(1)
  )[0];
  if (!installation) {
    console.warn(
      `review job skipped: unknown installation ${payload.installationId}`,
    );
    return;
  }
  if (installation.suspended) {
    console.warn(
      `review job skipped: installation ${payload.installationId} suspended`,
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
      `review job skipped: repository ${payload.repoFullName} missing or disabled`,
    );
    return;
  }
  const signedOrStoredPrivate =
    repository.private || payload.repositoryPrivate === true;
  const repositoryAccess = await canProcessRepositoryInference(db, {
    orgId: installation.orgId,
    repositoryPrivate: signedOrStoredPrivate,
  });
  if (!repositoryAccess.allowed) {
    console.warn(
      `review job skipped: private repository ${payload.repoFullName} requires billing`,
    );
    return;
  }
  const llm = await resolveLlmConfig(installation.orgId);
  if (
    !providerModeMatchesRepositoryAccess(
      signedOrStoredPrivate,
      repositoryAccess,
      llm.byok,
    )
  ) {
    console.warn(
      `review job skipped: private repository ${payload.repoFullName} provider mode does not match billing`,
    );
    return;
  }
  const hostedReviewUnavailable =
    !llm.byok && !(await hostedInferenceAvailable(getPool()));
  if (hostedReviewUnavailable) {
    const trigger = normalizeReviewTriggerContext(payload.trigger);
    const paused = await claimPausedHostedReview(
      db,
      {
        repositoryId: repository.id,
        prNumber: payload.prNumber,
        authorGithubId: payload.authorGithubId ?? null,
        authorLogin: payload.authorLogin ?? null,
        headSha: payload.headSha,
        baseSha: payload.baseSha,
        sinceSha: null,
        triggerSource: trigger.source,
        triggerContext: trigger,
        queuedAt: timing.queuedAt,
        startedAt: timing.startedAt,
      },
      {
        installationId: payload.installationId,
        repoFullName: payload.repoFullName,
        checkRunsMayExist: false,
      },
    );
    console.warn(
      `review job skipped: managed hosted inference is unavailable${paused ? "" : "; pause already recorded"}`,
    );
    return;
  }
  const token = await translateWorkerAbort(
    getInstallationToken(payload.installationId, signal),
    signal,
  );
  const currentRepository = await translateWorkerAbort(
    fetchRepositorySummary(token, payload.repoFullName, signal),
    signal,
  );
  await db
    .update(schema.repositories)
    .set({
      fullName: currentRepository.full_name,
      private: currentRepository.private,
    })
    .where(eq(schema.repositories.id, repository.id));
  const currentAccess = await canProcessRepositoryInference(db, {
    orgId: installation.orgId,
    repositoryPrivate: currentRepository.private,
  });
  if (
    !currentAccess.allowed ||
    !providerModeMatchesRepositoryAccess(
      currentRepository.private,
      currentAccess,
      llm.byok,
    )
  ) {
    console.warn(
      `review job skipped: current visibility for ${payload.repoFullName} requires matching billing`,
    );
    return;
  }

  let authorGithubId = payload.authorGithubId;
  let authorLogin = payload.authorLogin;
  if (currentRepository.private) {
    const context = await translateWorkerAbort(
      getPullRequestReviewContext(
        token,
        currentRepository.full_name,
        payload.prNumber,
        signal,
      ),
      signal,
    );
    if (
      context.headSha !== payload.headSha ||
      context.baseSha !== payload.baseSha
    ) {
      console.warn(
        `review job skipped: ${currentRepository.full_name}#${payload.prNumber} refs changed before author verification`,
      );
      return;
    }
    if (
      typeof context.authorGithubId !== "number" ||
      !Number.isSafeInteger(context.authorGithubId) ||
      context.authorGithubId <= 0 ||
      !context.authorLogin
    ) {
      throw new OperationalError(
        "private review author identity is unavailable",
      );
    }
    authorGithubId = context.authorGithubId;
    authorLogin = context.authorLogin;
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
  const preventionHint = await shouldSendPreventionHint(
    db,
    repository.id,
    payload.prNumber,
  );
  // Validate the configured origin before inserting a running review. A bad
  // deployment setting must not create a row that only the watchdog can close.
  const publicOrigin = configuredPublicOrigin();

  const trigger = normalizeReviewTriggerContext(payload.trigger);
  const reviewValues = {
    repositoryId: repository.id,
    prNumber: payload.prNumber,
    authorGithubId: authorGithubId ?? null,
    authorLogin: authorLogin ?? null,
    headSha: payload.headSha,
    baseSha: payload.baseSha,
    sinceSha: baseline?.headSha ?? null,
    triggerSource: trigger.source,
    triggerContext: trigger,
    queuedAt: timing.queuedAt,
    startedAt: timing.startedAt,
  };
  const inserted = (
    await db
      .insert(schema.reviews)
      .values({ ...reviewValues, status: "running" })
      .returning({ id: schema.reviews.id, publicId: schema.reviews.publicId })
  )[0];
  const reviewId = inserted?.id;
  const publicId = inserted?.publicId;
  if (reviewId === undefined || !publicId)
    throw new Error("review insert returned no row");
  const detailsUrl =
    publicOrigin && installation.orgSlug
      ? new URL(
          `/orgs/${encodeURIComponent(installation.orgSlug)}/runs/${publicId}`,
          publicOrigin,
        ).toString()
      : undefined;

  const reviewLog = new ReviewLogWriter(reviewId);
  reviewLog.line(
    `review queued at ${timing.queuedAt.toISOString()} -> worker claimed at ${timing.startedAt.toISOString()}`,
  );

  let advisoryCheckRunId: number | undefined;
  let gateCheckRunId: number | undefined;
  let baselinePath: string | undefined;
  let workDir: string | undefined;
  let sensitiveValues: string[] = [];
  let hostedUsageReservationId: string | null = null;
  let cliStarted = false;
  let publicationStarted = false;
  let receiptUsageForRace: ReviewCompletionInput["usage"] | undefined;
  let usageAccountingCompleteForRace = false;
  let advisoryCheckRunMayExist = false;
  let gateCheckRunMayExist = false;
  const advisoryCheckExternalId = checkRunExternalId(publicId, "review");
  const gateCheckExternalId = checkRunExternalId(publicId, "gate");
  const expectedFailureCheckRuns = (
    publicationIncomplete = false,
  ): ExpectedFailureCheckRuns => ({
    ...(advisoryCheckRunId === undefined
      ? {}
      : {
          advisory: {
            id: advisoryCheckRunId,
            name: ADVISORY_CHECK_NAME,
            externalId: advisoryCheckExternalId,
            headSha: payload.headSha,
          },
        }),
    ...(gateCheckRunId === undefined
      ? {}
      : {
          gate: {
            id: gateCheckRunId,
            name: GATE_CHECK_NAME,
            externalId: gateCheckExternalId,
            headSha: payload.headSha,
          },
        }),
    publicationIncomplete,
  });

  try {
    throwIfWorkerStopping(signal);
    sensitiveValues = [token];
    reviewLog.setSensitiveValues(sensitiveValues);
    publicationStarted = true;
    onPublicationStarted?.();
    const superseded = await supersedeActiveReviews({
      repositoryId: repository.id,
      prNumber: payload.prNumber,
      newHeadSha: payload.headSha,
      repoFullName: payload.repoFullName,
      token,
      excludeReviewId: reviewId,
    });
    if (superseded > 0)
      reviewLog.line(`superseded ${superseded} earlier active review(s)`);

    advisoryCheckRunId = await createCheckRun(
      token,
      payload.repoFullName,
      ADVISORY_CHECK_NAME,
      payload.headSha,
      { signal, externalId: advisoryCheckExternalId },
    ).catch((error) => {
      advisoryCheckRunMayExist =
        error instanceof AmbiguousCheckRunCreationError;
      throw error;
    });
    await db
      .update(schema.reviews)
      .set({ advisoryCheckRunId })
      .where(eq(schema.reviews.id, reviewId));
    gateCheckRunId = await createCheckRun(
      token,
      payload.repoFullName,
      GATE_CHECK_NAME,
      payload.headSha,
      { signal, externalId: gateCheckExternalId },
    ).catch((error) => {
      gateCheckRunMayExist = error instanceof AmbiguousCheckRunCreationError;
      throw error;
    });
    await db
      .update(schema.reviews)
      .set({ gateCheckRunId })
      .where(eq(schema.reviews.id, reviewId));
    reviewLog.line("forge check-runs created");

    throwIfWorkerStopping(signal);
    reviewLog.line(await postilCliVersionLogLine());
    const spendReservation = !llm.byok
      ? await reserveHostedReviewSpend(db, {
          orgId: installation.orgId,
          reviewId,
          usesByok: llm.byok,
        })
      : null;
    if (spendReservation && !spendReservation.allowed) {
      const message =
        "Hosted inference allowance is unavailable or fully reserved.";
      const settled = await db.transaction(async (tx) => {
        const failedRows = await tx
          .update(schema.reviews)
          .set({
            status: "failed",
            errorMessage: message,
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(schema.reviews.id, reviewId),
              eq(schema.reviews.status, "running"),
            ),
          )
          .returning({ id: schema.reviews.id });
        if (failedRows.length === 0) return false;
        await tx.insert(schema.jobs).values({
          kind: "check-run-cleanup",
          payload: {
            installationId: payload.installationId,
            repoFullName: payload.repoFullName,
            advisoryCheckRunId,
            gateCheckRunId,
            headSha: payload.headSha,
            advisoryCheckExternalId,
            gateCheckExternalId,
            advisoryCheckRunMayExist,
            gateCheckRunMayExist,
            message,
            detailsUrl,
            intent: "fail",
          },
          maxAttempts: 5,
        });
        return true;
      });
      if (settled) {
        await failCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId,
          gateCheckRunId,
          message,
          undefined,
          false,
          detailsUrl,
          expectedFailureCheckRuns(),
        );
      }
      reviewLog.line(
        "hosted inference reservation denied before provider access",
      );
      console.warn(
        `review job skipped: private repository ${payload.repoFullName} has no hosted inference capacity`,
      );
      return;
    }
    hostedUsageReservationId = spendReservation?.reservationId ?? null;
    if (hostedUsageReservationId)
      reviewLog.line("hosted inference spend reserved");

    const args = [
      "review",
      "--forge",
      "github",
      // Remote CLI invocations are local-only by default. The hosted worker is
      // the explicit publication boundary, so it must opt in deliberately.
      "--publish",
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
    if (optionalEnv("POSTIL_LOCAL_REVIEW_BOUNDED") === "1") {
      args.push("--bounded");
    }
    if (baseline?.envelope) {
      await mkdir(join(CACHE_DIR, "baselines"), { recursive: true });
      baselinePath = join(CACHE_DIR, "baselines", `review-${reviewId}.json`);
      await writeFile(baselinePath, JSON.stringify(baseline.envelope));
      // Absolute: the CLI resolves --baseline against its own cwd, which is
      // the per-review work dir below, not the worker's.
      args.push(
        "--since-sha",
        baseline.headSha,
        "--baseline",
        resolve(baselinePath),
      );
    }
    args.push("--output", "json");

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
      { allowModelSettings: llm.byok },
    );
    if (repoConfigFiles.length > 0) {
      console.log(
        `review ${reviewId}: using repo config from ${payload.repoFullName} (${repoConfigFiles.join(", ")})`,
      );
    }
    let sharedConfigFiles: string[] = [];
    let sharedProvenance: ConfigProvenanceEntry[] = [];
    const missingSharedSlots = missingRepositoryConfigSlots(repoConfigFiles);
    if (
      missingSharedSlots.length > 0 &&
      installation.orgId !== null &&
      installation.githubOrgId !== null &&
      (await resolveSharedConfigEnabled(installation.orgId))
    ) {
      const owner = currentRepository.full_name.split("/", 1)[0];
      if (owner) {
        const shared = await resolveOwnerGithubConfig(
          createOwnerConfigStore(db),
          {
            token,
            orgId: installation.orgId,
            githubOwnerId: installation.githubOrgId,
            installationId: installation.id,
            owner,
            requiredSlots: missingSharedSlots,
          },
        );
        sharedProvenance = shared.provenance;
        sharedConfigFiles = await materializeSharedConfig(
          workDir,
          repoConfigFiles,
          shared.config,
          { allowModelSettings: llm.byok },
        );
        reviewLog.line(
          `shared configuration ${shared.status}${shared.stale ? " (last known good snapshot)" : ""}`,
        );
      }
    }
    const orgConfigFiles = await materializeOrgConfig(
      workDir,
      [
        ...repoConfigFiles,
        ...sharedConfigFiles.map((file) => file.slice("shared:".length)),
      ],
      await resolveOrgReviewConfig(installation.orgId),
    );
    if (orgConfigFiles.length > 0) {
      console.log(
        `review ${reviewId}: using hosted organization config (${orgConfigFiles
          .map((file) => file.slice(4))
          .join(", ")})`,
      );
    }
    const configFiles = [
      ...repoConfigFiles,
      ...sharedConfigFiles,
      ...orgConfigFiles,
    ];
    const configProvenance = buildConfigProvenance(
      configFiles,
      sharedProvenance,
      {
        id: currentRepository.id,
        fullName: currentRepository.full_name,
      },
    );
    reviewLog.line(
      `configuration materialized (${configFiles.length > 0 ? configFiles.join(", ") : "no overrides"})`,
    );

    sensitiveValues = [
      token,
      llm.apiKey,
      llm.apiAuthHeader,
      llm.apiAuthValue,
    ].filter((value): value is string => Boolean(value));
    reviewLog.setSensitiveValues(sensitiveValues);
    throwIfWorkerStopping(signal);
    const cliEnv = buildCliEnv(llm, {
      GITHUB_TOKEN: token,
      POSTIL_EXPECTED_GITHUB_REPO_ID: String(repository.githubRepoId),
      ...(detailsUrl ? { POSTIL_DETAILS_URL: detailsUrl } : {}),
      POSTIL_PREVENTION_HINT: preventionHint ? "1" : "0",
      POSTIL_PREVENTION_COMMANDS_JSON: JSON.stringify(
        preventionHint
          ? await discoverPreventionCommands(token, payload.repoFullName)
          : [],
      ),
    });

    reviewLog.line("postil CLI spawned");
    cliStarted = true;
    const result = await runCli(args, cliEnv, workDir, {
      onStderrLine: (line) => reviewLog.line(`[stderr] ${line}`),
      signal,
    });
    reviewLog.line(
      `postil CLI exited with code ${result.exitCode}${result.timedOut ? " after timeout" : ""}`,
    );

    if (result.timedOut) {
      throw new OperationalError(
        `review exceeded ${REVIEW_DEADLINE_MS / 60000} minute deadline`,
      );
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
    for (const incident of classifyOperationalModelIncidents(
      ingested.envelope,
    )) {
      reportOperationalModelIncident(observabilityProcessGroup, incident);
    }
    reviewLog.line(
      `envelope ingested (${Buffer.byteLength(result.stdout)} bytes, ${ingested.envelope.findings.length} findings, gate ${ingested.gateFailing ? "failing" : "passing"})`,
    );
    const hasOperationalFinding = ingested.envelope.findings.some(
      (finding) =>
        finding.path === ".postil/operational" ||
        finding.path === ".postil/provider",
    );
    const receiptUsage = (
      ingested.modelUsage ?? [
        {
          model: ingested.modelUsed,
          promptTokens: ingested.promptTokens,
          completionTokens: ingested.completionTokens,
        },
      ]
    ).map((entry) => ({
      orgId: installation.orgId,
      repositoryId: repository.id,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      modelUsed: entry.model,
      // A legacy aggregate is priced only when modelUsed names one known
      // catalog model. Chains/consensus remain unpriced and consume the
      // full reservation rather than undercharging a fallback.
      costMicros: calculateUsageCostMicrosForModel(
        entry.model,
        entry.promptTokens,
        entry.completionTokens,
      ),
      billingScope: !llm.byok
        ? ("private_hosted" as const)
        : ("analytics" as const),
    }));
    receiptUsageForRace = receiptUsage;
    usageAccountingCompleteForRace = ingested.usageAccountingComplete;
    try {
      await Promise.all([
        verifyCompletedCheckRun(
          token,
          payload.repoFullName,
          {
            id: advisoryCheckRunId,
            name: ADVISORY_CHECK_NAME,
            externalId: advisoryCheckExternalId,
            headSha: payload.headSha,
            conclusion: hasOperationalFinding ? "neutral" : "success",
            requireOutput: true,
          },
          signal,
        ),
        verifyCompletedCheckRun(
          token,
          payload.repoFullName,
          {
            id: gateCheckRunId,
            name: GATE_CHECK_NAME,
            externalId: gateCheckExternalId,
            headSha: payload.headSha,
            conclusion: ingested.gateFailing ? "failure" : "success",
            requireOutput: true,
          },
          signal,
        ),
      ]);
    } catch (error) {
      if (error instanceof CheckRunPublicationError) {
        throw error;
      }
      throw new CheckRunPublicationError(
        "GitHub review publication could not be verified",
        { cause: error },
      );
    }
    reviewLog.line("forge check-runs verified completed by the CLI");

    // Guard on status so a completion racing a superseding push or watchdog
    // cannot flap the row back to completed or attribute usage to a run that
    // no longer owns the result. The CLI owns the success-path check-runs.
    const completed = await persistReviewCompletion(db, {
      reviewId,
      envelope: ingested.envelope,
      configFiles,
      configProvenance,
      silent: ingested.silent,
      gateFailing: ingested.gateFailing,
      usage: receiptUsage,
      hostedUsageReservationId,
      usageAccountingComplete: ingested.usageAccountingComplete,
    });

    if (!completed) {
      if (hostedUsageReservationId) {
        await reconcileHostedReviewSpendFromReceipt(db, {
          reservationId: hostedUsageReservationId,
          repositoryId: repository.id,
          reviewId,
          triggerSource: reviewValues.triggerSource,
          usage: receiptUsage,
          usageAccountingComplete: ingested.usageAccountingComplete,
        });
      }
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
        reviewLog.line(
          "forge check-runs restored to neutral after supersession",
        );
      }
      console.warn(
        `review ${reviewId} completed after it was already superseded or failed`,
      );
    }
  } catch (err) {
    if (err instanceof CheckRunPublicationError && receiptUsageForRace) {
      const terminal = (
        await db
          .select({ status: schema.reviews.status })
          .from(schema.reviews)
          .where(eq(schema.reviews.id, reviewId))
          .limit(1)
      )[0];
      if (terminal?.status === "stale") {
        if (hostedUsageReservationId) {
          await reconcileHostedReviewSpendFromReceipt(db, {
            reservationId: hostedUsageReservationId,
            repositoryId: repository.id,
            reviewId,
            triggerSource: reviewValues.triggerSource,
            usage: receiptUsageForRace,
            usageAccountingComplete: usageAccountingCompleteForRace,
          });
        }
        await neutralizeSupersededCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId ?? null,
          gateCheckRunId ?? null,
          "superseded by a newer review",
        );
        reviewLog.line(
          "forge check-runs restored to neutral after supersession",
        );
        console.warn(
          `review ${reviewId} publication verification raced with supersession`,
        );
        return;
      }
    }
    if (err instanceof WorkerShutdownError && !publicationStarted) {
      reviewLog.line(err.message);
      await db
        .update(schema.reviews)
        .set({ status: "stale", finishedAt: new Date() })
        .where(
          and(
            eq(schema.reviews.id, reviewId),
            eq(schema.reviews.status, "running"),
          ),
        );
      await releaseHostedReviewSpend(db, hostedUsageReservationId).catch(
        (releaseError) => {
          console.error(
            `failed to release hosted usage reservation: ${redactSecrets(releaseError)}`,
          );
        },
      );
      throw err;
    }
    const interruptedAfterPublication = err instanceof WorkerShutdownError;
    const publicationIncomplete = err instanceof CheckRunPublicationError;
    const message = interruptedAfterPublication
      ? "review interrupted after GitHub publication began"
      : redactSecrets(err, sensitiveValues);
    reviewLog.line(`review failed: ${message}`);
    const failedRows = await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.reviews)
        .set({
          status: "failed",
          errorMessage: redactAndTruncate(message, 2000, sensitiveValues),
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(schema.reviews.id, reviewId),
            eq(schema.reviews.status, "running"),
          ),
        )
        .returning({ id: schema.reviews.id });
      if (rows.length === 0) return rows;
      await tx.insert(schema.jobs).values({
        kind: "check-run-cleanup",
        payload: {
          installationId: payload.installationId,
          repoFullName: payload.repoFullName,
          advisoryCheckRunId: advisoryCheckRunId ?? null,
          gateCheckRunId: gateCheckRunId ?? null,
          headSha: payload.headSha,
          advisoryCheckExternalId,
          gateCheckExternalId,
          advisoryCheckRunMayExist,
          gateCheckRunMayExist,
          message,
          detailsUrl,
          intent: "fail",
          publicationIncomplete,
        },
        maxAttempts: 5,
      });
      return rows;
    });
    if (hostedUsageReservationId && cliStarted) {
      await reconcileConservativeHostedReviewSpend(db, {
        reservationId: hostedUsageReservationId,
        repositoryId: repository.id,
        reviewId,
        triggerSource: reviewValues.triggerSource,
      }).catch((reconcileError) => {
        console.error(
          `failed to conservatively reconcile hosted review usage: ${redactSecrets(reconcileError)}`,
        );
      });
    } else {
      await releaseHostedReviewSpend(db, hostedUsageReservationId).catch(
        (releaseError) => {
          console.error(
            `failed to release unused hosted usage reservation: ${redactSecrets(releaseError)}`,
          );
        },
      );
    }
    // Without a token there are no check-runs to complete (creation is the
    // first tokened call); with one, fail them closed - unless the watchdog
    // already claimed this review and completed them itself (0 rows above).
    if (token && failedRows.length > 0) {
      await failCheckRuns(
        token,
        payload.repoFullName,
        advisoryCheckRunId,
        gateCheckRunId,
        message,
        undefined,
        false,
        detailsUrl,
        expectedFailureCheckRuns(publicationIncomplete),
      );
      reviewLog.line("forge check-runs updated for review failure");
    }
    throw interruptedAfterPublication ? new OperationalError(message) : err;
  } finally {
    if (baselinePath)
      await rm(baselinePath, { force: true }).catch(() => undefined);
    if (workDir)
      await rm(workDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
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
        input.onlyDifferentHead
          ? ne(schema.reviews.headSha, input.newHeadSha)
          : undefined,
      ),
    );
  if (active.length === 0) return 0;

  let token = input.token;
  if (
    !token &&
    active.some(
      (review) =>
        review.advisoryCheckRunId != null || review.gateCheckRunId != null,
    )
  ) {
    if (input.githubInstallationId === undefined) {
      throw new Error(
        "cannot complete superseded check-runs without an installation id",
      );
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

export async function completeHostedInferenceDisabledCheckRuns(
  token: string,
  repoFullName: string,
  advisoryCheckRunId: number | undefined,
  gateCheckRunId: number | undefined,
  throwOnError = false,
): Promise<boolean> {
  const summary =
    "Postil did not run a review for this commit. No review comment or verdict was published.";
  const errors: unknown[] = [];
  for (const [kind, checkRunId] of [
    ["advisory", advisoryCheckRunId],
    ["gate", gateCheckRunId],
  ] as const) {
    if (checkRunId === undefined) continue;
    await completeCheckRun(
      token,
      repoFullName,
      checkRunId,
      "neutral",
      "Review unavailable",
      summary,
    ).catch((error) => {
      errors.push(error);
      console.error(
        `failed to neutralize unavailable ${kind} check-run: ${redactSecrets(error, [token])}`,
      );
    });
  }
  if (throwOnError && errors.length > 0) {
    throw new AggregateError(
      errors,
      "could not neutralize unavailable review check-runs",
    );
  }
  return errors.length === 0;
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
  _message: string,
  signal?: AbortSignal,
  throwOnError = false,
  detailsUrl?: string,
  expectedChecks?: ExpectedFailureCheckRuns,
): Promise<void> {
  const details = detailsUrl ? `\n\n[Review details](${detailsUrl})` : "";
  const publicationIncomplete =
    expectedChecks?.publicationIncomplete === true;
  if (
    publicationIncomplete &&
    ((gateCheckRunId != null && !expectedChecks?.gate) ||
      (advisoryCheckRunId != null && !expectedChecks?.advisory))
  ) {
    throw new CheckRunPublicationError(
      "publication cleanup requires the exact GitHub check-run identities",
    );
  }
  const title = publicationIncomplete
    ? "Review publication incomplete"
    : "Review did not complete";
  const summary = publicationIncomplete
    ? `Postil completed the review, but GitHub did not receive the complete result. This run is not a published review verdict.${details}`
    : `Postil could not complete this review, so no review verdict exists.${details}`;
  const errors: unknown[] = [];
  const complete = async (
    checkRunId: number,
    expected: ExpectedCheckRunIdentity | undefined,
    conclusion: "failure" | "neutral",
    checkSummary: string,
  ): Promise<void> => {
    if (!expected) {
      await completeCheckRun(
        token,
        repoFullName,
        checkRunId,
        conclusion,
        title,
        checkSummary,
        signal,
      );
      return;
    }
    if (expected.id !== checkRunId) {
      throw new CheckRunPublicationError(
        `GitHub check-run ${checkRunId} differs from its recorded review identity`,
      );
    }
    await completeExpectedCheckRun(
      token,
      repoFullName,
      { ...expected, conclusion },
      title,
      checkSummary,
      signal,
    );
  };
  if (gateCheckRunId != null) {
    const gateSummary = publicationIncomplete
      ? `${summary}\n\nThe merge check remains blocked because the reviewed result was not fully published. Re-request the check.`
      : `${summary}\n\nThe merge check remains blocked because an unreviewed head is not a passing head. Push again or re-request the check.`;
    await complete(
      gateCheckRunId,
      expectedChecks?.gate,
      "failure",
      gateSummary,
    ).catch((error) => {
      errors.push(error);
      console.error(
        `failed to complete gate check-run: ${redactSecrets(error, [token])}`,
      );
    });
  }
  if (advisoryCheckRunId != null) {
    await complete(
      advisoryCheckRunId,
      expectedChecks?.advisory,
      "neutral",
      summary,
    ).catch((error) => {
      errors.push(error);
      console.error(
        `failed to complete advisory check-run: ${redactSecrets(error, [token])}`,
      );
    });
  }
  if (throwOnError && errors.length > 0) {
    throw new AggregateError(
      errors,
      "could not complete failed review check-runs",
    );
  }
}

/** Retryable worker job that completes check-runs after a watchdog kill. */
export async function runCheckRunCleanupJob(
  payload: CheckRunCleanupJobPayload,
  timeoutMs = 10_000,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = await getInstallationToken(
      payload.installationId,
      controller.signal,
    );
    const errors: unknown[] = [];
    const complete = async (
      advisoryCheckRunId: number | null | undefined,
      gateCheckRunId: number | null | undefined,
    ) => {
      if (payload.intent === "neutralize") {
        await completeHostedInferenceDisabledCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId ?? undefined,
          gateCheckRunId ?? undefined,
          true,
        );
        return;
      }
      const expectedChecks: ExpectedFailureCheckRuns = {
        ...(advisoryCheckRunId != null &&
        payload.headSha &&
        payload.advisoryCheckExternalId
          ? {
              advisory: {
                id: advisoryCheckRunId,
                name: ADVISORY_CHECK_NAME,
                externalId: payload.advisoryCheckExternalId,
                headSha: payload.headSha,
              },
            }
          : {}),
        ...(gateCheckRunId != null &&
        payload.headSha &&
        payload.gateCheckExternalId
          ? {
              gate: {
                id: gateCheckRunId,
                name: GATE_CHECK_NAME,
                externalId: payload.gateCheckExternalId,
                headSha: payload.headSha,
              },
            }
          : {}),
        publicationIncomplete: payload.publicationIncomplete === true,
      };
      await failCheckRuns(
        token,
        payload.repoFullName,
        advisoryCheckRunId,
        gateCheckRunId,
        payload.message,
        controller.signal,
        true,
        payload.detailsUrl,
        expectedChecks,
      );
    };

    await complete(payload.advisoryCheckRunId, payload.gateCheckRunId).catch(
      (error) => {
        errors.push(error);
      },
    );

    let reconciledAdvisoryCheckRunId: number | null = null;
    let reconciledGateCheckRunId: number | null = null;
    if (
      payload.advisoryCheckRunId == null &&
      payload.advisoryCheckRunMayExist &&
      payload.headSha &&
      payload.advisoryCheckExternalId
    ) {
      try {
        reconciledAdvisoryCheckRunId = await findCheckRunByExternalId(
          token,
          payload.repoFullName,
          payload.headSha,
          ADVISORY_CHECK_NAME,
          payload.advisoryCheckExternalId,
          controller.signal,
        );
        if (reconciledAdvisoryCheckRunId === null) {
          errors.push(
            new Error("ambiguous advisory check-run is not visible yet"),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (
      payload.gateCheckRunId == null &&
      payload.gateCheckRunMayExist &&
      payload.headSha &&
      payload.gateCheckExternalId
    ) {
      try {
        reconciledGateCheckRunId = await findCheckRunByExternalId(
          token,
          payload.repoFullName,
          payload.headSha,
          GATE_CHECK_NAME,
          payload.gateCheckExternalId,
          controller.signal,
        );
        if (reconciledGateCheckRunId === null) {
          errors.push(new Error("ambiguous gate check-run is not visible yet"));
        }
      } catch (error) {
        errors.push(error);
      }
    }
    await complete(
      reconciledAdvisoryCheckRunId,
      reconciledGateCheckRunId,
    ).catch((error) => {
      errors.push(error);
    });
    if (errors.length > 0) {
      throw new AggregateError(errors, "check-run cleanup remains incomplete");
    }
  } finally {
    clearTimeout(timer);
  }
}
