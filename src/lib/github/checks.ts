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
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
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
    body: JSON.stringify(body),
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
): Promise<void> {
  await githubFetch(token, "PATCH", `/repos/${repoFullName}/check-runs/${checkRunId}`, {
    status: "completed",
    completed_at: new Date().toISOString(),
    conclusion,
    output: { title, summary },
  });
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
): Promise<void> {
  await githubFetch(token, "POST", `/repos/${repoFullName}/issues/${number}/comments`, { body });
}
