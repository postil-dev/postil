import { z } from "zod";
import { env } from "@/lib/env";
import { installationOctokit } from "@/lib/github";
import { captureException } from "@/lib/posthog";

export const reviewPayload = z.object({
  installationId: z.number().int(),
  repoFullName: z.string(),
  pullNumber: z.number().int(),
  headSha: z.string(),
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
  "summary": "<one short paragraph>",
  "findings": [ { "path": "...", "line": <int>, "severity": "info|warn|error", "body": "..." } ]
}
`.trim();

function parseEnvelope(text: string): ReviewEnvelope {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  const json = JSON.parse(raw.slice(start, end + 1));
  return {
    summary: String(json.summary ?? ""),
    findings: Array.isArray(json.findings) ? json.findings.filter(isFinding) : [],
  };
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
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
      max_tokens: 1500,
    }),
  });
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
  const envelope = parseEnvelope(modelOutput);

  const body = envelope.findings.length
    ? `**Postil** reviewed this PR with \`${env.REVIEW_MODEL}\`.\n\n${envelope.summary}`
    : `**Postil** reviewed this PR with \`${env.REVIEW_MODEL}\`. No issues found.\n\n${envelope.summary}`;

  const comments = envelope.findings.map((f) => ({
    path: f.path,
    line: f.line,
    side: "RIGHT" as const,
    body: `**${f.severity.toUpperCase()}** · ${f.body}`,
  }));

  try {
    await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner,
      repo,
      pull_number: payload.pullNumber,
      commit_id: payload.headSha,
      event: "COMMENT",
      body,
      comments: comments.length ? comments : undefined,
    });
  } catch (err) {
    captureException(err, {
      properties: { op: "post_review", repoFullName: payload.repoFullName, pullNumber: payload.pullNumber },
    });
    // Fall back to an issue comment if inline review API rejected the payload.
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: payload.pullNumber,
      body: `${body}\n\n_(inline review failed; posted as comment)_`,
    });
  }

  return envelope;
}
