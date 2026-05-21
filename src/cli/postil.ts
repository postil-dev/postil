#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { env } from "@/lib/env";
import { callOpenRouterReview } from "@/jobs/openrouter-review";
import { parseReviewModelCascade } from "@/jobs/review-models";
import { SYSTEM_PROMPT, parseEnvelope, type Finding } from "@/jobs/run-review";

interface ReviewTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function resolveTarget(args: readonly string[]): ReviewTarget {
  const repoArg = argValue(args, "--repo") ?? process.env.GITHUB_REPOSITORY;
  const prArg = argValue(args, "--pr");
  const shaArg = argValue(args, "--sha");

  const eventPath = process.env.GITHUB_EVENT_PATH;
  let eventPr: { number?: number; head?: { sha?: string } } | undefined;
  if (eventPath) {
    try {
      const ev = JSON.parse(readFileSync(eventPath, "utf-8"));
      eventPr = ev?.pull_request;
    } catch {
      // ignore — fall through to CLI args
    }
  }

  if (!repoArg) throw new Error("repo unknown: set --repo or GITHUB_REPOSITORY");
  const [owner, repo] = repoArg.split("/");
  if (!owner || !repo) throw new Error(`invalid repo: ${repoArg}`);

  const pullNumber = Number(prArg ?? eventPr?.number);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("pr unknown: set --pr or run via pull_request event");
  }

  const headSha = shaArg ?? eventPr?.head?.sha ?? "";
  return { owner, repo, pullNumber, headSha };
}

const DIFF_LIMIT = 120_000;

async function fetchDiff(octokit: Octokit, target: ReviewTarget): Promise<string> {
  const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    mediaType: { format: "diff" },
  });
  const diff = String(res.data);
  return diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n\n[diff truncated]` : diff;
}

async function runCascade(diff: string): Promise<{ findings: Finding[]; summary: string; model: string }> {
  const cascade = parseReviewModelCascade(env.REVIEW_MODEL_CASCADE, env.REVIEW_MODEL);
  const errors: string[] = [];
  for (const model of cascade) {
    try {
      const r = await callOpenRouterReview(model, SYSTEM_PROMPT, diff);
      const envelope = parseEnvelope(r.content, r.usage, r.modelUsed);
      return { findings: envelope.findings, summary: envelope.summary, model: r.modelUsed };
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`all models failed:\n${errors.join("\n")}`);
}

function renderCheckOutput(
  findings: Finding[],
  summary: string,
  model: string,
): { title: string; summary: string; text?: string } {
  const title =
    findings.length === 0
      ? `No findings (${model})`
      : `${findings.length} finding${findings.length === 1 ? "" : "s"} (${model})`;
  if (findings.length === 0) {
    return { title, summary };
  }
  const text = findings
    .map(
      (f) =>
        `**${f.severity.toUpperCase()}** \`${f.path}:${f.line}\`\n\n${f.body}`,
    )
    .join("\n\n---\n\n");
  return { title, summary, text };
}

async function postCheckRun(
  octokit: Octokit,
  target: ReviewTarget,
  findings: Finding[],
  summary: string,
  model: string,
  startedAt: string,
): Promise<"success" | "failure" | "neutral"> {
  if (!target.headSha) return "neutral";
  const conclusion: "success" | "failure" = findings.some((f) => f.severity === "error")
    ? "failure"
    : "success";
  const now = new Date().toISOString();
  await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner: target.owner,
    repo: target.repo,
    name: "postil/review",
    head_sha: target.headSha,
    status: "completed",
    conclusion,
    started_at: startedAt,
    completed_at: now,
    output: renderCheckOutput(findings, summary, model),
  });
  return conclusion;
}

async function postInlineReview(
  octokit: Octokit,
  target: ReviewTarget,
  findings: Finding[],
  summary: string,
): Promise<void> {
  const comments = findings.map((f) => ({
    path: f.path,
    line: f.line,
    side: "RIGHT" as const,
    body: `**${f.severity.toUpperCase()}** · ${f.body}`,
  }));
  await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    commit_id: target.headSha || undefined,
    event: comments.length === 0 ? "COMMENT" : "COMMENT",
    body: summary,
    comments,
  });
}

async function cmdReview(args: readonly string[]): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");

  const target = resolveTarget(args);
  const failOn =
    argValue(args, "--fail-on") ??
    process.env.POSTIL_FAIL_ON ??
    "error"; // exit 1 if any finding has this severity or higher
  const skipInline = hasFlag(args, "--no-inline");

  const octokit = new Octokit({ auth: token });
  const startedAt = new Date().toISOString();

  const diff = await fetchDiff(octokit, target);
  if (!diff.trim()) {
    console.log("[postil] empty diff — nothing to review");
    if (target.headSha) {
      await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
        owner: target.owner,
        repo: target.repo,
        name: "postil/review",
        head_sha: target.headSha,
        status: "completed",
        conclusion: "neutral",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output: { title: "Empty diff", summary: "Nothing to review." },
      });
    }
    return;
  }

  const { findings, summary, model } = await runCascade(diff);

  if (!skipInline) {
    try {
      await postInlineReview(octokit, target, findings, summary);
    } catch (err) {
      console.warn(`[postil] inline review post failed: ${(err as Error).message}`);
    }
  }

  const conclusion = await postCheckRun(octokit, target, findings, summary, model, startedAt);

  console.log(
    `[postil] ${target.owner}/${target.repo}#${target.pullNumber} → ${conclusion} (${findings.length} findings, model: ${model})`,
  );

  const severityRank: Record<string, number> = { info: 1, warn: 2, error: 3 };
  const failThreshold = severityRank[failOn] ?? 3;
  const blocking = findings.some((f) => (severityRank[f.severity] ?? 0) >= failThreshold);
  if (blocking) process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "review";
  const rest = argv.slice(1);
  switch (cmd) {
    case "review":
      await cmdReview(rest);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(
        "postil — self-hosted AI PR reviewer\n\n" +
          "Usage:\n" +
          "  bun run postil review                 review the PR from $GITHUB_EVENT_PATH\n" +
          "  bun run postil review --repo o/r --pr 123 [--sha SHA]\n\n" +
          "Flags:\n" +
          "  --fail-on info|warn|error  Exit 1 when any finding meets this severity (default: error)\n" +
          "  --no-inline                Skip posting an inline PR review (check-run only)\n\n" +
          "Env:\n" +
          "  GITHUB_TOKEN                Required.\n" +
          "  OPENROUTER_API_KEY          Required.\n" +
          "  REVIEW_MODEL                Default: moonshotai/kimi-k2.6\n" +
          "  REVIEW_MODEL_CASCADE        Optional comma-list; tried in order.\n",
      );
      return;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`[postil] ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
