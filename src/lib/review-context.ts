/**
 * Reads thread context (prior reviews, comments, dismissals) for a pull
 * request and renders it as a compact "Prior thread" block for the LLM
 * prompt. Capped at ~3K tokens; oldest entries truncated first.
 */
import type { Octokit } from "@octokit/rest";

export type ThreadEntry = {
  kind: "review" | "comment" | "inline";
  author: string;
  body: string;
  /** Present only for reviews */
  state?: string;
  /** Present only for dismissed reviews */
  dismissedAt?: string;
  dismissalMessage?: string;
  /** Present only for inline comments */
  path?: string;
  line?: number;
};

export type PRThread = {
  entries: ThreadEntry[];
  /** Number of entries truncated because of the token cap */
  truncated: number;
};

/**
 * Fetches thread context for a given PR:
 * - Last 30 reviews (including dismissed)
 * - Last 30 issue comments
 * - Last 30 inline review comments
 *
 * Returns a compact representation capped at ~3K tokens.
 */
export async function fetchPRThread(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PRThread> {
  const entries: ThreadEntry[] = [];

  // 1. Reviews
  try {
    const { data: reviews } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      { owner, repo, pull_number: pullNumber, per_page: 30 },
    );
    for (const r of reviews) {
      if (!r.user) continue;
      const entry: ThreadEntry = {
        kind: "review",
        author: r.user.login ?? "unknown",
        body: r.body ?? "",
        state: r.state ?? undefined,
      };
      if (r.state === "dismissed" && r.submitted_at) {
        entry.dismissedAt = r.submitted_at;
        // Dismissal message is separate API; best-effort fetch.
        entry.dismissalMessage = r.body ?? undefined;
      }
      if (entry.state || entry.body) {
        entries.push(entry);
      }
    }
  } catch {
    // Non-fatal — thread context is advisory
  }

  // 2. Issue (PR-level) comments
  try {
    const { data: comments } = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: pullNumber, per_page: 30 },
    );
    for (const c of comments) {
      if (!c.user) continue;
      entries.push({
        kind: "comment",
        author: c.user.login ?? "unknown",
        body: c.body ?? "",
      });
    }
  } catch {
    // non-fatal
  }

  // 3. Inline review comments
  try {
    const { data: inline } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      { owner, repo, pull_number: pullNumber, per_page: 30 },
    );
    for (const c of inline) {
      if (!c.user) continue;
      entries.push({
        kind: "inline",
        author: c.user.login ?? "unknown",
        body: c.body ?? "",
        path: c.path ?? undefined,
        line: c.line ?? undefined,
      });
    }
  } catch {
    // non-fatal
  }

  // 4. Also scan the last CLOSED PR on the same repo for prior feedback.
  try {
    const { data: closedPrs } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      { owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 1 },
    );
    const lastClosed = closedPrs[0];
    if (lastClosed && lastClosed.number !== pullNumber) {
      const { data: priorReviews } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { owner, repo, pull_number: lastClosed.number, per_page: 10 },
      );
      for (const r of priorReviews) {
        if (!r.user) continue;
        // Only include meaningful feedback — skip raw "APPROVE" with no body
        if (!r.body && (!r.state || r.state === "APPROVED")) continue;
        entries.push({
          kind: "review",
          author: r.user.login ?? "unknown",
          body: r.body ?? "",
          state: r.state ?? undefined,
        });
      }
    }
  } catch {
    // non-fatal
  }

  // Render to terse text, oldest-first, and cap at ~3K tokens (~12K chars)
  const textLines: string[] = [];
  // Sort by recency — most recent first — for the display, but we'll
  // truncate oldest first.
  textLines.push("Prior thread on this PR:");

  // Sort entries: most recent first is more useful for the LLM
  const sorted = entries.slice().reverse();
  const CAP = 12_000;
  let totalChars = textLines[0].length + 1;
  let rendered = 0;

  for (const e of sorted) {
    let line = "";
    switch (e.kind) {
      case "review":
        line = `- review by ${e.author}: state=${e.state ?? "?"}`;
        if (e.dismissedAt) line += `, dismissed_at=${e.dismissedAt}`;
        if (e.dismissalMessage) line += `, dismissal_message="${e.dismissalMessage}"`;
        if (e.body) line += `, body="${e.body}"`;
        break;
      case "comment":
        line = `- comment by ${e.author}: "${e.body}"`;
        break;
      case "inline":
        line = `- inline by ${e.author} at ${e.path}:${e.line ?? "?"}: "${e.body}"`;
        break;
    }
    const nextLen = totalChars + line.length + 1;
    if (nextLen > CAP) break;
    textLines.push(line);
    totalChars = nextLen;
    rendered++;
  }

  return {
    entries,
    truncated: entries.length - rendered,
  };
}

export async function fetchLastClosedPRThread(
  octokit: Octokit,
  owner: string,
  repo: string,
  currentPullNumber: number,
): Promise<ThreadEntry[]> {
  const entries: ThreadEntry[] = [];
  try {
    const { data: closedPrs } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      { owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 1 },
    );
    const lastClosed = closedPrs[0];
    if (lastClosed && lastClosed.number !== currentPullNumber) {
      const { data: priorReviews } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { owner, repo, pull_number: lastClosed.number, per_page: 10 },
      );
      for (const r of priorReviews) {
        if (!r.user) continue;
        if (!r.body && (!r.state || r.state === "APPROVED")) continue;
        entries.push({
          kind: "review",
          author: r.user.login ?? "unknown",
          body: r.body ?? "",
          state: r.state ?? undefined,
        });
      }
    }
  } catch {
    // non-fatal
  }
  return entries;
}

/**
 * Renders thread entries (from PR thread + last closed PR) as a compact
 * plain-text block for the LLM prompt. Returns empty string when there is
 * nothing to inject. Capped at ~3K tokens (~12K chars).
 */
export function formatPRThread(entries: ThreadEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  lines.push("Prior thread on this PR:");

  const CAP = 12_000;
  let totalChars = lines[0].length + 1;
  let rendered = 0;

  for (const e of entries) {
    let line = "";
    switch (e.kind) {
      case "review":
        line = `- review by ${e.author}: state=${e.state ?? "?"}`;
        if (e.dismissedAt) line += `, dismissed_at=${e.dismissedAt}`;
        if (e.dismissalMessage) line += `, dismissal_message="${e.dismissalMessage}"`;
        if (e.body) line += `, body="${e.body.slice(0, 500)}"`;
        break;
      case "comment":
        line = `- comment by ${e.author}: "${e.body.slice(0, 500)}"`;
        break;
      case "inline":
        line = `- inline by ${e.author} at ${e.path}:${e.line ?? "?"}: "${e.body.slice(0, 500)}"`;
        break;
    }
    const nextLen = totalChars + line.length + 1;
    if (nextLen > CAP) break;
    lines.push(line);
    totalChars = nextLen;
    rendered++;
  }

  if (entries.length > rendered) {
    const n = entries.length - rendered;
    lines.push(`... and ${n} more entr${n > 1 ? "ies" : "y"} truncated.`);
  }

  return lines.join("\n");
}
