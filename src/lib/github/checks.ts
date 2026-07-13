import { apiBase } from "./app-auth";

/**
 * Check-run REST helpers.
 *
 * The worker (not the CLI) creates both check-runs so it owns their ids
 * even if the CLI crashes; the CLI completes them on the happy path. On
 * crash/timeout the worker completes them itself: gate -> `failure`
 * (fail closed; a grey square that reads as "didn't fail" is the mistake
 * to avoid), advisory -> `neutral` with the operational error summary.
 */

export const ADVISORY_CHECK_NAME = "postil/review";
export const GATE_CHECK_NAME = "postil/gate";

type Conclusion = "success" | "failure" | "neutral";

async function githubFetch(
  token: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "postil-control-plane",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res;
}

export async function createCheckRun(
  token: string,
  repoFullName: string,
  name: string,
  headSha: string,
): Promise<number> {
  const res = await githubFetch(token, "POST", `/repos/${repoFullName}/check-runs`, {
    name,
    head_sha: headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  });
  const data = (await res.json()) as { id: number };
  return data.id;
}

export async function completeCheckRun(
  token: string,
  repoFullName: string,
  checkRunId: number,
  conclusion: Conclusion,
  title: string,
  summary: string,
  signal?: AbortSignal,
): Promise<void> {
  await githubFetch(token, "PATCH", `/repos/${repoFullName}/check-runs/${checkRunId}`, {
    status: "completed",
    completed_at: new Date().toISOString(),
    conclusion,
    output: { title, summary },
  }, signal);
}

/**
 * Post a comment to a PR or issue. GitHub exposes one endpoint for both:
 * `POST /repos/{repo}/issues/{number}/comments` works on pull requests too
 * (a PR is an issue with code attached), so respond jobs can reuse it
 * regardless of whether the mention came from an issue or a PR.
 */
export async function postIssueComment(
  token: string,
  repoFullName: string,
  number: number,
  body: string,
  signal?: AbortSignal,
): Promise<number> {
  const response = await githubFetch(
    token,
    "POST",
    `/repos/${repoFullName}/issues/${number}/comments`,
    { body },
    signal,
  );
  const data = (await response.json()) as { id?: number };
  if (!Number.isSafeInteger(data.id)) throw new Error("GitHub comment response has no valid id");
  return data.id!;
}

/** Find a previously posted respond marker after an ambiguous delivery. */
export async function findIssueCommentByMarker(
  token: string,
  repoFullName: string,
  number: number,
  marker: string,
  since: Date,
  signal?: AbortSignal,
): Promise<number | null> {
  const query = new URLSearchParams({ per_page: "100", since: since.toISOString() });
  const response = await githubFetch(
    token,
    "GET",
    `/repos/${repoFullName}/issues/${number}/comments?${query}`,
    undefined,
    signal,
  );
  const comments = (await response.json()) as Array<{ id?: number; body?: string }>;
  const match = comments.find(
    (comment) => Number.isSafeInteger(comment.id) && comment.body?.includes(marker),
  );
  return match?.id ?? null;
}

export async function getPullRequestHeadSha(
  token: string,
  repoFullName: string,
  number: number,
): Promise<string> {
  const res = await githubFetch(token, "GET", `/repos/${repoFullName}/pulls/${number}`);
  const data = (await res.json()) as { head?: { sha?: string } };
  const headSha = data.head?.sha;
  if (!headSha) throw new Error(`GitHub pull request ${repoFullName}#${number} has no head sha`);
  return headSha;
}
