import { Octokit } from "@octokit/rest";
import { loadReviewConfig, type PostilConfig } from "@/lib/config";
import { env } from "@/lib/env";
import { appOctokit, installationOctokit } from "@/lib/github";
import { captureException, track } from "@/lib/posthog";
import { attemptAutoMergeApprovedPull } from "./auto-merge";
import { callOpenRouterReview, type OpenRouterResult } from "./openrouter-review";
import { parseReviewModelCascade } from "./review-models";
import { reviewEnvelope, type ReviewPayload } from "./review-types";

export type Finding = {
  path: string;
  line: number;
  severity: "info" | "warn" | "error";
  body: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/** Zero-valued usage for paths that never call the LLM. */
const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export type ReviewEnvelope = {
  summary: string;
  findings: Finding[];
  usage: TokenUsage;
  modelUsed?: string;
};

export type ReviewClients = {
  installation?: Octokit;
};

type CheckRunClient = Pick<Octokit, "request">;

const ALLOWED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

type GitHubUser = {
  login?: unknown;
  type?: unknown;
};

type ReviewThreadEvent = {
  kind: "review" | "review-comment" | "issue-comment";
  author: string;
  body: string;
  state?: string;
  timestamp?: string;
  path?: string;
  line?: number | null;
};

type ReviewContext = {
  prompt: string;
  outstandingChangeRequestReviewers: string[];
  hasExternalActivity: boolean;
  loaded: boolean;
};

export const SYSTEM_PROMPT = `
You are Postil, a code reviewer. You receive a unified diff for a pull request
and produce structured findings as JSON. Rules:
- Focus on correctness, security, and obvious bugs.
- Do not flag style, formatting, imports, or naming unless they cause a bug.
- Every finding cites a specific path and line number that exists in the diff.
- Severity is one of: info, warn, error.
- If the diff looks fine, return an empty findings array and a short summary.

Reply with ONLY a single JSON object, no prose, no markdown fence:
{
  "summary": "<2-4 sentences max summarizing overall risk posture. Do NOT restate individual findings.>",
  "findings": [ { "path": "...", "line": <int>, "severity": "info|warn|error", "body": "..." } ]
}
`.trim();

export function parseEnvelope(text: string, usage: TokenUsage, modelUsed?: string): ReviewEnvelope {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    try {
      return reviewEnvelope.parse({
        ...JSON.parse(raw.slice(start, end + 1)),
        usage,
        modelUsed,
      });
    } catch {
      throw reviewOutputParseError();
    }
  }
  throw reviewOutputParseError();
}

function hasSubstantiveBody(item: ReviewThreadEvent): boolean {
  return item.body.trim() !== "";
}

function sortNewestFirst(items: ReviewThreadEvent[]): ReviewThreadEvent[] {
  return [...items].sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });
}

function userLogin(user: GitHubUser | null): string {
  return typeof user?.login === "string" ? user.login : "";
}

function normalizeLogin(login: string): string {
  return login.toLowerCase();
}

function isCurrentAppBotUser(user: GitHubUser | null, appBotLogin: string | null): boolean {
  const login = userLogin(user);
  return !!appBotLogin && normalizeLogin(login) === normalizeLogin(appBotLogin);
}

function isSubstantiveExternalActivity(
  body: string,
  user: GitHubUser | null,
  appBotLogin: string | null,
): boolean {
  return body.trim() !== "" && !isCurrentAppBotUser(user, appBotLogin);
}

function dismissedBy(rawReview: unknown): GitHubUser | null {
  return (rawReview as { dismissed_by?: GitHubUser | null }).dismissed_by ?? null;
}

async function fetchCurrentAppBotLogin(): Promise<string | null> {
  const fallbackSlug = String(env.GITHUB_APP_SLUG ?? "").trim();
  try {
    const octokit = appOctokit();
    const appRes = await octokit.request("GET /app");
    const slug = String((appRes.data as { slug?: unknown }).slug ?? "").trim();
    if (slug) return `${slug}[bot]`;
    return fallbackSlug ? `${fallbackSlug}[bot]` : null;
  } catch {
    console.warn("[review-context] app identity fetch failed");
    return fallbackSlug ? `${fallbackSlug}[bot]` : null;
  }
}

export async function hasApprovedReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
): Promise<boolean> {
  const appBotLogin = await fetchCurrentAppBotLogin();
  if (!appBotLogin) return false;

  const reviews = await fetchPaginated(
    octokit,
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    {
      owner,
      repo,
      pull_number: pullNumber,
    },
  );

  let latestApprovedReviewAt = 0;
  let latestState: string | null = null;

  for (const rawReview of reviews) {
    if (!rawReview || typeof rawReview !== "object") continue;
    const state = String((rawReview as { state?: unknown }).state ?? "");
    if (!ALLOWED_REVIEW_STATES.has(state)) continue;
    const reviewCommit = String((rawReview as { commit_id?: unknown }).commit_id ?? "");
    if (reviewCommit !== headSha) continue;
    const authorObj = (rawReview as { user?: GitHubUser | null }).user ?? null;
    if (!isCurrentAppBotUser(authorObj, appBotLogin)) continue;
    const submittedAt = String(
      (rawReview as { submitted_at?: unknown; updated_at?: unknown; created_at?: unknown })
        .submitted_at ??
        (rawReview as { updated_at?: unknown; created_at?: unknown }).updated_at ??
        (rawReview as { created_at?: unknown }).created_at ??
        "",
    );
    const reviewTime = Number.isNaN(Date.parse(submittedAt)) ? 0 : Date.parse(submittedAt);
    if (reviewTime >= latestApprovedReviewAt) {
      latestApprovedReviewAt = reviewTime;
      latestState = state;
    }
  }

  return latestState === "APPROVED";
}

function outstandingChangeRequestReviewers(items: ReviewThreadEvent[]): string[] {
  const latestStateByAuthor = new Map<string, string>();
  const reviews = [...items]
    .filter((item) => item.kind === "review" && item.state)
    .sort((a, b) => {
      const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
      const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
      return aTime - bTime;
    });

  for (const item of reviews) {
    if (
      item.state === "CHANGES_REQUESTED" ||
      item.state === "APPROVED" ||
      item.state === "DISMISSED"
    ) {
      latestStateByAuthor.set(item.author, item.state);
    }
  }

  return [...latestStateByAuthor.entries()]
    .filter(([, state]) => state === "CHANGES_REQUESTED")
    .map(([author]) => author)
    .sort();
}

function formatReviewContext(items: ReviewThreadEvent[]): ReviewContext {
  if (!items.length) {
    return {
      prompt: "",
      outstandingChangeRequestReviewers: [],
      hasExternalActivity: false,
      loaded: true,
    };
  }

  const quote = (body: string) => `"${body.slice(0, 300)}"`;
  const lines: string[] = [];
  const reviewItems = sortNewestFirst(items.filter((item) => item.kind === "review"));
  const substantiveReviews = reviewItems.filter(hasSubstantiveBody).slice(0, 10);
  const inlineComments = sortNewestFirst(
    items.filter((item) => item.kind === "review-comment" && hasSubstantiveBody(item)),
  ).slice(0, 10);
  const issueComments = sortNewestFirst(
    items.filter((item) => item.kind === "issue-comment" && hasSubstantiveBody(item)),
  ).slice(0, 5);
  const outstandingReviewers = outstandingChangeRequestReviewers(items);
  if (reviewItems.length) {
    const stateCounts = reviewItems.reduce<Record<string, number>>((counts, item) => {
      const state = item.state ?? "UNKNOWN";
      counts[state] = (counts[state] ?? 0) + 1;
      return counts;
    }, {});
    const summary = Object.entries(stateCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([state, count]) => `${state}=${count}`)
      .join(" ");
    lines.push(`Review events: ${summary}`);
    if (outstandingReviewers.length) {
      lines.push(
        `Outstanding change requests: ${outstandingReviewers.map((a) => `@${a}`).join(", ")}`,
      );
    }
    lines.push("");
  }

  if (substantiveReviews.length) {
    lines.push("Human review feedback (newest first):");
    for (const item of substantiveReviews) {
      const timestamp = item.timestamp ? ` at ${item.timestamp}` : "";
      lines.push(`- [${item.state}] @${item.author}${timestamp}: ${quote(item.body)}`);
    }
  }

  if (inlineComments.length) {
    if (lines.length) lines.push("");
    lines.push("Inline comments:");
    for (const item of inlineComments) {
      lines.push(
        `- @${item.author} at ${item.path}:${item.line ?? "unknown"}: ${quote(item.body)}`,
      );
    }
  }

  if (issueComments.length) {
    if (lines.length) lines.push("");
    lines.push("PR comments:");
    for (const item of issueComments) {
      lines.push(`- @${item.author}: ${quote(item.body)}`);
    }
  }

  return {
    prompt: lines.join("\n"),
    outstandingChangeRequestReviewers: outstandingReviewers,
    hasExternalActivity: items.length > 0,
    loaded: true,
  };
}

async function fetchPaginated(
  octokit: Octokit,
  route: string,
  params: Record<string, unknown>,
  options: { maxPages?: number; maxItems?: number } = {},
): Promise<unknown[]> {
  const perPage = 100;
  const maxPages = options.maxPages ?? 5;
  const maxItems = options.maxItems ?? 300;
  const items: unknown[] = [];

  for (let page = 1; page <= maxPages && items.length < maxItems; page++) {
    const res = await octokit.request(route, {
      ...params,
      per_page: perPage,
      page,
    });
    if (!Array.isArray(res.data)) {
      return items;
    }

    const remaining = maxItems - items.length;
    items.push(...res.data.slice(0, remaining));
    if (res.data.length < perPage || items.length >= maxItems) {
      return items;
    }
  }

  return items;
}

async function fetchReviewContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  appBotLogin: string | null,
): Promise<ReviewContext> {
  try {
    const [reviewsRes, reviewCommentRes, issueCommentRes] = await Promise.all([
      fetchPaginated(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: pullNumber,
      }),
      fetchPaginated(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
        owner,
        repo,
        pull_number: pullNumber,
      }),
      fetchPaginated(octokit, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: pullNumber,
      }),
    ]);

    const items: ReviewThreadEvent[] = [];

    if (Array.isArray(reviewsRes)) {
      for (const rawReview of reviewsRes) {
        const state = String((rawReview as { state?: unknown }).state ?? "");
        if (!ALLOWED_REVIEW_STATES.has(state)) continue;
        const body = String((rawReview as { body?: unknown }).body ?? "").trim();
        const dismissalMessage = String(
          (rawReview as { dismissal_message?: unknown }).dismissal_message ?? "",
        ).trim();
        const authorObj = (rawReview as { user?: GitHubUser | null }).user ?? null;
        const author = userLogin(authorObj) || "unknown";
        const submittedAt = String((rawReview as { submitted_at?: unknown }).submitted_at ?? "");
        if (isCurrentAppBotUser(authorObj, appBotLogin)) {
          const dismissalAuthor = dismissedBy(rawReview);
          if (
            state === "DISMISSED" &&
            dismissalMessage &&
            isSubstantiveExternalActivity(dismissalMessage, dismissalAuthor, appBotLogin)
          ) {
            items.push({
              kind: "issue-comment",
              author: userLogin(dismissalAuthor) || "unknown",
              body: dismissalMessage,
              timestamp: submittedAt || undefined,
            });
          }
          continue;
        }
        items.push({
          kind: "review",
          author,
          body: [body, dismissalMessage].filter(Boolean).join(" "),
          state,
          timestamp: submittedAt || undefined,
        });
      }
    }

    if (Array.isArray(reviewCommentRes)) {
      for (const rawComment of reviewCommentRes) {
        const authorObj = (rawComment as { user?: GitHubUser | null }).user ?? null;
        if (isCurrentAppBotUser(authorObj, appBotLogin)) continue;
        const body = String((rawComment as { body?: unknown }).body ?? "").trim();
        const author = userLogin(authorObj) || "unknown";
        items.push({
          kind: "review-comment",
          author,
          body,
          path: String((rawComment as { path?: unknown }).path ?? ""),
          line: (rawComment as { line?: number | null }).line ?? null,
          timestamp:
            String(
              (rawComment as { updated_at?: unknown; created_at?: unknown }).updated_at ??
                (rawComment as { created_at?: unknown }).created_at ??
                "",
            ) || undefined,
        });
      }
    }

    if (Array.isArray(issueCommentRes)) {
      for (const rawComment of issueCommentRes) {
        const authorObj = (rawComment as { user?: GitHubUser | null }).user ?? null;
        if (isCurrentAppBotUser(authorObj, appBotLogin)) continue;
        const body = String((rawComment as { body?: unknown }).body ?? "").trim();
        const author = userLogin(authorObj) || "unknown";
        items.push({
          kind: "issue-comment",
          author,
          body,
          timestamp:
            String(
              (rawComment as { updated_at?: unknown; created_at?: unknown }).updated_at ??
                (rawComment as { created_at?: unknown }).created_at ??
                "",
            ) || undefined,
        });
      }
    }

    return formatReviewContext(items);
  } catch {
    console.error("[review-context] fetch failed");
    return {
      prompt: "",
      outstandingChangeRequestReviewers: [],
      hasExternalActivity: false,
      loaded: false,
    };
  }
}

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  info: 0,
  warn: 1,
  error: 2,
};

function matchesGlob(path: string, glob: string): boolean {
  // Minimal glob → regex: `**` matches any path segment(s), `*` matches non-slash.
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§DOUBLESTAR§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§DOUBLESTAR§§/g, ".*") +
      "$",
  );
  return re.test(path);
}

function applyConfig(env: ReviewEnvelope, cfg: PostilConfig): ReviewEnvelope {
  const threshold = SEVERITY_RANK[cfg.severityThreshold];
  const filtered = env.findings
    .filter((f) => SEVERITY_RANK[f.severity] >= threshold)
    .filter((f) => !cfg.ignore.some((glob) => matchesGlob(f.path, glob)))
    .slice(0, cfg.maxFindings);
  return { summary: env.summary, findings: filtered, usage: env.usage, modelUsed: env.modelUsed };
}

type OpenRouterCascadeError = Error & {
  modelUsed?: string;
  attemptedModels?: string[];
  providerFailures?: ProviderFailure[];
};

const OPENROUTER_REVIEW_TIMEOUT_MS = 8 * 60_000;

export type ProviderFailure = {
  model: string;
  reason: string;
  status?: number;
  errorClass?: string;
};

function formatReviewStatusLine(
  envelope: ReviewEnvelope,
  inlineComments: number,
  label: string,
): string {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of envelope.findings) counts[finding.severity]++;
  return `Postil status: ${label} | errors=${counts.error} warnings=${counts.warn} info=${counts.info} inline_comments=${inlineComments}`;
}

function appendReviewStatusLine(body: string, statusLine: string): string {
  const trimmed = body.trim();
  return trimmed ? `${trimmed}\n\n${statusLine}` : statusLine;
}

export function buildReviewUserContent(reviewContext: string, diff: string): string {
  return reviewContext ? `${reviewContext}\n\nDiff:\n\n${diff}` : `Diff:\n\n${diff}`;
}

export function isOpenRouterCascadeError(err: unknown): err is OpenRouterCascadeError {
  return (
    err instanceof Error &&
    Array.isArray((err as OpenRouterCascadeError).attemptedModels) &&
    (err as OpenRouterCascadeError).attemptedModels?.every((model) => typeof model === "string") ===
      true
  );
}

export function publicReviewErrorMessage(err: unknown): string {
  return isOpenRouterCascadeError(err)
    ? "Review failed after all configured model providers were unavailable."
    : err instanceof Error && err.name === "ReviewOutputError"
      ? "Model output was not valid Postil JSON."
    : "Review failed to complete.";
}

function reviewOutputParseError(): Error {
  const error = new Error("Model output was not valid Postil JSON.");
  error.name = "ReviewOutputError";
  error.stack = undefined;
  return error;
}

function sanitizedReviewSetupError(): Error {
  const error = new Error(publicReviewErrorMessage(new Error()));
  error.name = "ReviewSetupError";
  error.stack = undefined;
  return error;
}

function createRepositoryCheckRunClient(): CheckRunClient | null {
  if (!env.GITHUB_PAT) return null;
  return new Octokit({ auth: env.GITHUB_PAT });
}

const CHECK_RUN_REMEDIATION = "Restore GitHub App authentication and rerun the review.";
const CHECK_RUN_UNAVAILABLE_MESSAGE =
  "Review setup failed before a GitHub check client was available; the existing review check cannot be completed automatically.";

function reportUnavailableCheckRunCompletion(payload: ReviewPayload, err: unknown): void {
  if (!payload.checkRunId) return;

  const setupFailure = sanitizedReviewSetupError();
  const errorClass = err instanceof Error ? err.name : typeof err;
  console.error("[check-run]", CHECK_RUN_UNAVAILABLE_MESSAGE, {
    errorClass,
    requiredAction: CHECK_RUN_REMEDIATION,
  });
  captureException(setupFailure, {
    properties: {
      op: "review_check_completion_unavailable",
      repoFullName: payload.repoFullName,
      pullNumber: payload.pullNumber,
      headSha: payload.headSha,
      checkRunId: payload.checkRunId,
      errorClass,
      requiredAction: CHECK_RUN_REMEDIATION,
    },
  });
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }

  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function providerFailureFromError(
  model: string,
  err: unknown,
  cascadeTimedOut: boolean,
): ProviderFailure {
  const errorClass = err instanceof Error ? err.name : typeof err;
  if (cascadeTimedOut || errorClass === "AbortError") {
    return { model, reason: "cascade timeout", errorClass: "AbortError" };
  }

  const status =
    err instanceof Error ? Number(err.message.match(/^openrouter (\d+)/)?.[1]) : Number.NaN;

  return {
    model,
    reason: Number.isInteger(status) ? "provider returned an error" : "request failed",
    status: Number.isInteger(status) ? status : undefined,
    errorClass,
  };
}

async function callOpenRouter(diff: string, reviewContext = ""): Promise<OpenRouterResult> {
  const userContent = buildReviewUserContent(reviewContext, diff);
  const failures: ProviderFailure[] = [];
  const attemptedModels: string[] = [];
  const configuredModels = parseReviewModelCascade(env.REVIEW_MODEL_CASCADE, env.REVIEW_MODEL);
  const cascadeStartedAt = Date.now();
  const cascadeController = new AbortController();
  const cascadeTimeout = setTimeout(() => cascadeController.abort(), OPENROUTER_REVIEW_TIMEOUT_MS);

  try {
    for (const model of configuredModels) {
      const remainingMs = OPENROUTER_REVIEW_TIMEOUT_MS - (Date.now() - cascadeStartedAt);
      if (remainingMs <= 0 || cascadeController.signal.aborted) {
        failures.push({ model, reason: "skipped after cascade timeout" });
        break;
      }
      attemptedModels.push(model);

      const requestController = new AbortController();
      const unlinkCascade = linkAbortSignal(cascadeController.signal, requestController);
      try {
        const result = await callOpenRouterReview(
          model,
          SYSTEM_PROMPT,
          userContent,
          requestController.signal,
        );
        unlinkCascade();
        return result;
      } catch (err) {
        unlinkCascade();
        const failure = providerFailureFromError(model, err, cascadeController.signal.aborted);
        console.warn("[openrouter] model request failed", failure);
        failures.push(failure);
      }
    }
  } finally {
    clearTimeout(cascadeTimeout);
  }

  const error = new Error(
    "openrouter model cascade failed after all configured providers were unavailable",
  ) as OpenRouterCascadeError;
  error.modelUsed = attemptedModels.at(-1) ?? configuredModels[0];
  error.attemptedModels = attemptedModels;
  error.providerFailures = failures;
  throw error;
}

export async function runReview(
  payload: ReviewPayload,
  clients: ReviewClients = {},
): Promise<ReviewEnvelope> {
  const [owner, repo] = payload.repoFullName.split("/");

  let octokit: Octokit | null = null;
  let checkRunCompleted = false;
  let setupComplete = false;
  try {
    octokit = clients.installation ?? (await installationOctokit(payload.installationId));
    const pullRes = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: payload.pullNumber,
    });
    const baseSha = String((pullRes.data as { base?: { sha?: unknown } }).base?.sha ?? "");
    const { config } = await loadReviewConfig(octokit, owner, repo, baseSha);
    if (!config.enabled) {
      if (payload.checkRunId) {
        try {
          await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
            owner,
            repo,
            check_run_id: payload.checkRunId,
            status: "completed",
            conclusion: "neutral",
            completed_at: new Date().toISOString(),
            output: {
              title: "Postil Review",
              summary: "Postil is disabled for this repo via config.",
            },
          });
        } catch (err) {
          console.error("[check-run] PATCH failed (disabled)");
          captureException(err, {
            properties: {
              op: "update_check_run_disabled",
              repoFullName: payload.repoFullName,
              pullNumber: payload.pullNumber,
            },
          });
        }
      }
      return {
        summary: "Postil is disabled for this repo via config.",
        findings: [],
        usage: ZERO_USAGE,
      };
    }
    const appBotLogin = await fetchCurrentAppBotLogin();
    const pullAuthor = (pullRes.data as { user?: GitHubUser | null }).user ?? null;
    const isSelfAuthoredPull = isCurrentAppBotUser(pullAuthor, appBotLogin);

    const reviewContext = await fetchReviewContext(
      octokit,
      owner,
      repo,
      payload.pullNumber,
      appBotLogin,
    );

    if (reviewContext.loaded && isSelfAuthoredPull && !reviewContext.hasExternalActivity) {
      if (payload.checkRunId) {
        try {
          await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
            owner,
            repo,
            check_run_id: payload.checkRunId,
            status: "completed",
            conclusion: "success",
            completed_at: new Date().toISOString(),
            output: {
              title: "No issues",
              summary: "No issues found.",
              text: "No issues found.",
            },
          });
          checkRunCompleted = true;
          track("system", "update_check_run", {
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
            conclusion: "success",
          });
        } catch (err) {
          console.error("[check-run] PATCH failed");
          captureException(err, {
            properties: {
              op: "update_check_run",
              repoFullName: payload.repoFullName,
              pullNumber: payload.pullNumber,
            },
          });
        }
      }

      return {
        summary: "No issues found.",
        findings: [],
        usage: ZERO_USAGE,
      };
    }

    const diffRes = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: payload.pullNumber,
      mediaType: { format: "diff" },
    });
    const diff = String(diffRes.data);
    const MAX = 120_000;
    const truncated = diff.length > MAX ? `${diff.slice(0, MAX)}\n\n[diff truncated]` : diff;

    setupComplete = true;
    const {
      content: modelOutput,
      usage,
      modelUsed,
    } = await callOpenRouter(truncated, reviewContext.prompt);
    let envelope = parseEnvelope(modelOutput, usage, modelUsed);
    envelope = applyConfig(envelope, config);

    // Concise main review body — no filler or self-promotion
    const comments = envelope.findings.map((f) => ({
      path: f.path,
      line: f.line,
      side: "RIGHT" as const,
      body: `**${f.severity.toUpperCase()}** · ${f.body}`,
    }));

    // Always post a review when there are findings or explicit change requests.
    // Clean PRs can skip the PR review when review.on_clean=skip in .postil.yaml.
    let approved = false;
    {
      const hasFindings = comments.length > 0;
      const hasOutstandingChangeRequests =
        reviewContext.outstandingChangeRequestReviewers.length > 0;
      const needsAttention = hasFindings || hasOutstandingChangeRequests;
      const statusLabel = needsAttention ? "needs-attention" : "clean";
      const statusLine = formatReviewStatusLine(envelope, comments.length, statusLabel);

      let shouldPost = config.review.enabled;
      if (shouldPost && !needsAttention && config.review.on_clean === "skip") {
        shouldPost = false;
      }

      if (shouldPost) {
        const event: "APPROVE" | "COMMENT" = needsAttention ? "COMMENT" : "APPROVE";
        const reviewBody = appendReviewStatusLine(
          envelope.summary || "Postil reviewed this PR.",
          statusLine,
        );

        try {
          await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
            owner,
            repo,
            pull_number: payload.pullNumber,
            commit_id: payload.headSha,
            event,
            body: reviewBody,
            comments: hasFindings ? comments : undefined,
          });
          approved = event === "APPROVE";
        } catch (err) {
          captureException(err, {
            properties: {
              op: "post_review",
              repoFullName: payload.repoFullName,
              pullNumber: payload.pullNumber,
            },
          });
          // Fall back to an issue comment if inline review API rejected the payload.
          const fallbackBody = reviewBody ?? envelope.summary;
          if (fallbackBody) {
            await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
              owner,
              repo,
              issue_number: payload.pullNumber,
              body: fallbackBody,
            });
          }
        }
      }
    }

    if (payload.checkRunId) {
      const counts = { error: 0, warn: 0, info: 0 };
      for (const f of envelope.findings) counts[f.severity]++;
      const hasOutstandingChangeRequests =
        reviewContext.outstandingChangeRequestReviewers.length > 0;
      const changeRequestSummary = hasOutstandingChangeRequests
        ? `Outstanding change requests: ${reviewContext.outstandingChangeRequestReviewers
            .map((a) => `@${a}`)
            .join(", ")}`
        : "";
      const title = counts.error
        ? `${counts.error} error${counts.error > 1 ? "s" : ""}`
        : counts.warn
          ? `${counts.warn} warning${counts.warn > 1 ? "s" : ""}`
          : hasOutstandingChangeRequests
            ? `${reviewContext.outstandingChangeRequestReviewers.length} change request${reviewContext.outstandingChangeRequestReviewers.length > 1 ? "s" : ""}`
            : "No issues";
      const outputText = hasOutstandingChangeRequests
        ? changeRequestSummary
        : envelope.findings.length
          ? "See inline review comments."
          : "No issues found.";
      const conclusion = hasOutstandingChangeRequests
        ? "failure"
        : counts.error
          ? "failure"
          : counts.warn
            ? "neutral"
            : "success";
      try {
        await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
          owner,
          repo,
          check_run_id: payload.checkRunId,
          status: "completed",
          conclusion,
          completed_at: new Date().toISOString(),
          output: {
            title,
            summary: hasOutstandingChangeRequests
              ? [envelope.summary, changeRequestSummary].filter(Boolean).join("\n\n")
              : envelope.summary ||
                (counts.error || counts.warn || counts.info
                  ? "See inline review comments."
                  : "No issues found."),
            text: outputText,
          },
        });
        checkRunCompleted = true;
        track("system", "update_check_run", {
          repoFullName: payload.repoFullName,
          pullNumber: payload.pullNumber,
          conclusion,
        });
      } catch (err) {
        console.error("[check-run] PATCH failed");
        captureException(err, {
          properties: {
            op: "update_check_run",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
          },
        });
      }
    }

    // Auto-merge runs only after the review check has been completed. This
    // keeps the required review gate from waiting on GitHub mergeability or
    // merge endpoints, which can be slow or temporarily unavailable.
    if (approved && config.review.auto_merge && (!payload.checkRunId || checkRunCompleted)) {
      await attemptAutoMergeApprovedPull(octokit, owner, repo, payload, config.review);
    }

    return envelope;
  } catch (err) {
    const reportedError = setupComplete ? err : sanitizedReviewSetupError();
    const checkRunClient = octokit ?? createRepositoryCheckRunClient();
    if (payload.checkRunId && !checkRunCompleted) {
      if (checkRunClient) {
        console.error("[check-run] Review threw; completing check-run with failure");
        try {
          await checkRunClient.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
            owner,
            repo,
            check_run_id: payload.checkRunId,
            status: "completed",
            conclusion: "failure",
            completed_at: new Date().toISOString(),
            output: {
              title: "Postil Review",
              summary: publicReviewErrorMessage(reportedError),
              text: publicReviewErrorMessage(reportedError),
            },
          });
        } catch (patchErr) {
          console.error("[check-run] Emergency PATCH failed");
          captureException(patchErr, {
            properties: {
              op: "emergency_complete_check_run",
              repoFullName: payload.repoFullName,
              pullNumber: payload.pullNumber,
            },
          });
        }
      } else {
        reportUnavailableCheckRunCompletion(payload, reportedError);
      }
    }
    throw reportedError;
  }
}
