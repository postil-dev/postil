import { z } from "zod";
import { loadReviewConfig, type PostilConfig } from "@/lib/config";
import { env } from "@/lib/env";
import { installationOctokit } from "@/lib/github";
import { captureException, track } from "@/lib/posthog";

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

export type ReviewEnvelope = {
  summary: string;
  findings: Finding[];
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

function parseEnvelope(text: string): ReviewEnvelope {
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
      };
    } catch {
      // fall through to prose fallback
    }
  }
  // Prose fallback: post the model's reply verbatim as a summary, no inline findings.
  return { summary: text.trim().slice(0, 4000), findings: [] };
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
  return { summary: env.summary, findings: filtered };
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

async function callOpenRouter(diff: string): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
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
      model: env.REVIEW_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Diff:\n\n${diff}` },
      ],
      temperature: 0.2,
      max_tokens: 2500,
      response_format: { type: "json_object" },
    }),
  });
  clearTimeout(timeout);
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
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
        console.error("[check-run] PATCH failed (disabled):", err instanceof Error ? err.message : err);
        captureException(err, {
          properties: {
            op: "update_check_run_disabled",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
          },
        });
      }
    }
    return { summary: "Postil is disabled for this repo via config.", findings: [] };
  }

  let checkRunCompleted = false;
  try {
    const diffRes = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: payload.pullNumber,
        mediaType: { format: "diff" },
      },
    );
    const diff = String(diffRes.data);
    const MAX = 120_000;
    const truncated = diff.length > MAX ? `${diff.slice(0, MAX)}\n\n[diff truncated]` : diff;

    const modelOutput = await callOpenRouter(truncated);
    let envelope = parseEnvelope(modelOutput);
    envelope = applyConfig(envelope, config);

    // Concise main review body — no filler or self-promotion
    const comments = envelope.findings.map((f) => ({
      path: f.path,
      line: f.line,
      side: "RIGHT" as const,
      body: `**${f.severity.toUpperCase()}** · ${f.body}`,
    }));

    if (envelope.findings.length > 0 || envelope.summary) {
      try {
        await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
          owner,
          repo,
          pull_number: payload.pullNumber,
          commit_id: payload.headSha,
          event: comments.length ? "COMMENT" : "APPROVE",
          body: envelope.summary || undefined,
          comments: comments.length ? comments : undefined,
        });
      } catch (err) {
        captureException(err, {
          properties: { op: "post_review", repoFullName: payload.repoFullName, pullNumber: payload.pullNumber },
        });
        // Fall back to an issue comment if inline review API rejected the payload.
        if (envelope.summary) {
          await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
            owner,
            repo,
            issue_number: payload.pullNumber,
            body: envelope.summary,
          });
        }
      }
    }

    if (payload.checkRunId) {
      const counts = { error: 0, warn: 0, info: 0 };
      for (const f of envelope.findings) counts[f.severity]++;
      const title = counts.error
        ? `${counts.error} error${counts.error > 1 ? "s" : ""}`
        : counts.warn
          ? `${counts.warn} warning${counts.warn > 1 ? "s" : ""}`
          : "No issues";
      const outputText = envelope.findings.length ? "See inline review comments." : "No issues found.";
      const conclusion = counts.error ? "failure" : counts.warn ? "neutral" : "success";
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
            summary: envelope.summary || (counts.error || counts.warn || counts.info ? "See inline review comments." : "No issues found."),
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
        console.error("[check-run] Emergency PATCH failed:", patchErr instanceof Error ? patchErr.message : patchErr);
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
