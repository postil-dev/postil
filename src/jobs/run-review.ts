import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { loadReviewConfig, type PostilConfig } from "@/lib/config";
import { env } from "@/lib/env";
import { installationOctokit } from "@/lib/github";
import { captureException, track } from "@/lib/posthog";
import { parseReviewModelCascade } from "./review-models";

export const reviewPayload = z.object({
  installationId: z.number().int(),
  repoFullName: z.string(),
  pullNumber: z.number().int(),
  headSha: z.string(),
  checkRunId: z.number().int().optional(),
  reviewId: z.string().uuid().optional(),
});

export type ReviewPayload = z.infer<typeof reviewPayload>;

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

const ALLOWED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

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
};

const SYSTEM_PROMPT = `
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

function parseEnvelope(text: string, usage: TokenUsage, modelUsed?: string): ReviewEnvelope {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    try {
      const json = JSON.parse(raw.slice(start, end + 1));
      return {
        summary: String(json.summary ?? ""),
        findings: Array.isArray(json.findings) ? json.findings.filter(isFinding) : [],
        usage,
        modelUsed,
      };
    } catch {
      // fall through to prose fallback
    }
  }
  // Prose fallback: post the model's reply verbatim as a summary, no inline findings.
  return { summary: text.trim().slice(0, 4000), findings: [], usage, modelUsed };
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
        const authorObj = (rawReview as { user?: { login?: unknown } | null }).user ?? null;
        const author = typeof authorObj?.login === "string" ? authorObj.login : "unknown";
        const submittedAt = String((rawReview as { submitted_at?: unknown }).submitted_at ?? "");
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
        const body = String((rawComment as { body?: unknown }).body ?? "").trim();
        const authorObj = (rawComment as { user?: { login?: unknown } | null }).user ?? null;
        const author = typeof authorObj?.login === "string" ? authorObj.login : "unknown";
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
        const body = String((rawComment as { body?: unknown }).body ?? "").trim();
        const authorObj = (rawComment as { user?: { login?: unknown } | null }).user ?? null;
        const author = typeof authorObj?.login === "string" ? authorObj.login : "unknown";
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
  } catch (err) {
    console.error("[review-context] fetch failed:", err instanceof Error ? err.message : err);
    return {
      prompt: "",
      outstandingChangeRequestReviewers: [],
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

function isFinding(x: unknown): x is Finding {
  if (!x || typeof x !== "object") return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.path === "string" &&
    Number.isInteger(f.line) &&
    (f.severity === "info" || f.severity === "warn" || f.severity === "error") &&
    typeof f.body === "string"
  );
}

type OpenRouterResult = { content: string; usage: TokenUsage; modelUsed: string };

const OPENROUTER_MODEL_TIMEOUT_MS = 120_000;
const OPENROUTER_CASCADE_TIMEOUT_MS = 6 * 60_000;

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

async function callOpenRouter(diff: string, reviewContext = ""): Promise<OpenRouterResult> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  const userContent = reviewContext ? `${reviewContext}\n\nDiff:\n\n${diff}` : `Diff:\n\n${diff}`;
  const failures: string[] = [];
  const cascadeStartedAt = Date.now();

  for (const model of parseReviewModelCascade(env.REVIEW_MODEL_CASCADE, env.REVIEW_MODEL)) {
    const remainingMs = OPENROUTER_CASCADE_TIMEOUT_MS - (Date.now() - cascadeStartedAt);
    if (remainingMs <= 0) {
      failures.push(`${model}: skipped after cascade timeout`);
      break;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(OPENROUTER_MODEL_TIMEOUT_MS, remainingMs),
    );
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        signal: controller.signal,
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
          "http-referer": "https://postil.dev",
          "x-title": "Postil",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          temperature: 0.2,
          max_tokens: 2500,
          response_format: { type: "json_object" },
        }),
      });
      clearTimeout(timeout);

      if (!res.ok) {
        failures.push(`${model}: openrouter ${res.status}: ${(await res.text()).slice(0, 400)}`);
        continue;
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const orUsage = data.usage;
      const usage: TokenUsage = {
        promptTokens: orUsage?.prompt_tokens ?? 0,
        completionTokens: orUsage?.completion_tokens ?? 0,
        totalTokens: orUsage?.total_tokens ?? 0,
      };
      return { content: data.choices?.[0]?.message?.content ?? "", usage, modelUsed: model };
    } catch (err) {
      clearTimeout(timeout);
      failures.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`openrouter model cascade failed: ${failures.join(" | ")}`);
}

export async function runReview(payload: ReviewPayload): Promise<ReviewEnvelope> {
  const octokit = await installationOctokit(payload.installationId);
  const [owner, repo] = payload.repoFullName.split("/");

  const { config } = await loadReviewConfig(octokit, owner, repo, payload.headSha);
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
        console.error(
          "[check-run] PATCH failed (disabled):",
          err instanceof Error ? err.message : err,
        );
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

  let checkRunCompleted = false;
  try {
    const diffRes = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: payload.pullNumber,
      mediaType: { format: "diff" },
    });
    const diff = String(diffRes.data);
    const MAX = 120_000;
    const truncated = diff.length > MAX ? `${diff.slice(0, MAX)}\n\n[diff truncated]` : diff;
    const reviewContext = await fetchReviewContext(octokit, owner, repo, payload.pullNumber);

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
        let approved = false;

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

        // If configured, squash-merge clean approved PRs only after GitHub
        // reports that the PR is cleanly mergeable. This keeps the default safe
        // while allowing fully-green PRs to land without another manual step.
        if (approved && config.review.auto_merge) {
          try {
            const pull = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
              owner,
              repo,
              pull_number: payload.pullNumber,
            });
            if (pull.data.mergeable === true && pull.data.mergeable_state === "clean") {
              await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
                owner,
                repo,
                pull_number: payload.pullNumber,
                merge_method: "squash",
              });
              track("system", "auto_merge_completed", {
                repoFullName: payload.repoFullName,
                pullNumber: payload.pullNumber,
              });
            }
          } catch (err) {
            // Non-fatal: GitHub may still be computing mergeability, required
            // checks may be pending, or branch protection may reject the merge.
            console.warn(
              "[auto-merge] Could not merge clean PR:",
              err instanceof Error ? err.message : err,
            );
            captureException(err, {
              properties: {
                op: "auto_merge_clean_pr",
                repoFullName: payload.repoFullName,
                pullNumber: payload.pullNumber,
              },
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
        console.error("[check-run] PATCH failed:", err instanceof Error ? err.message : err);
        captureException(err, {
          properties: {
            op: "update_check_run",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
          },
        });
      }
    }

    return envelope;
  } catch (err) {
    if (payload.checkRunId && !checkRunCompleted) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[check-run] Review threw; completing check-run with failure:", message);
      try {
        await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
          owner,
          repo,
          check_run_id: payload.checkRunId,
          status: "completed",
          conclusion: "failure",
          completed_at: new Date().toISOString(),
          output: {
            title: "Postil Review",
            summary: "Review failed to complete.",
            text: `Error: ${message}`,
          },
        });
      } catch (patchErr) {
        console.error(
          "[check-run] Emergency PATCH failed:",
          patchErr instanceof Error ? patchErr.message : patchErr,
        );
        captureException(patchErr, {
          properties: {
            op: "emergency_complete_check_run",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
          },
        });
      }
    }
    throw err;
  }
}
