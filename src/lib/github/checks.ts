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
export const RESPOND_MARKER_MAX_PAGES = 10;

const ISSUE_COMMENTS_PAGE_SIZE = 100;
const CHECK_RUN_CREATE_TIMEOUT_MS = 10_000;
const CHECK_RUN_RECONCILE_TIMEOUT_MS = 5_000;
const CHECK_RUNS_PAGE_SIZE = 100;
const CHECK_RUNS_MAX_PAGES = 10;

type Conclusion = "success" | "failure" | "neutral";

class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubHttpError";
  }
}

export class AmbiguousCheckRunCreationError extends Error {
  constructor(
    readonly externalId: string,
    cause: unknown,
  ) {
    super(`GitHub check-run creation is ambiguous for ${externalId}`, { cause });
    this.name = "AmbiguousCheckRunCreationError";
  }
}

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
    throw new GitHubHttpError(
      res.status,
      `GitHub ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }
  return res;
}

export async function createCheckRun(
  token: string,
  repoFullName: string,
  name: string,
  headSha: string,
  options: { signal?: AbortSignal; externalId?: string } = {},
): Promise<number> {
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(CHECK_RUN_CREATE_TIMEOUT_MS)])
    : AbortSignal.timeout(CHECK_RUN_CREATE_TIMEOUT_MS);
  try {
    const res = await githubFetch(
      token,
      "POST",
      `/repos/${repoFullName}/check-runs`,
      {
        name,
        head_sha: headSha,
        status: "in_progress",
        started_at: new Date().toISOString(),
        ...(options.externalId ? { external_id: options.externalId } : {}),
      },
      requestSignal,
    );
    const data = (await res.json()) as { id: number };
    if (!Number.isSafeInteger(data.id)) {
      throw new Error("GitHub check-run response has no valid id");
    }
    return data.id;
  } catch (error) {
    const couldHaveReachedGitHub =
      !(error instanceof GitHubHttpError) || error.status >= 500;
    if (!options.externalId || !couldHaveReachedGitHub) throw error;
    const reconciled = await findCheckRunByExternalId(
      token,
      repoFullName,
      headSha,
      name,
      options.externalId,
      AbortSignal.timeout(CHECK_RUN_RECONCILE_TIMEOUT_MS),
    ).catch(() => null);
    if (reconciled !== null) return reconciled;
    throw new AmbiguousCheckRunCreationError(options.externalId, error);
  }
}

export function checkRunExternalId(
  reviewPublicId: string,
  kind: "review" | "gate",
): string {
  return `postil:${reviewPublicId}:${kind}`;
}

export async function findCheckRunByExternalId(
  token: string,
  repoFullName: string,
  headSha: string,
  name: string,
  externalId: string,
  signal?: AbortSignal,
): Promise<number | null> {
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      check_name: name,
      filter: "all",
      per_page: String(CHECK_RUNS_PAGE_SIZE),
      page: String(page),
    });
    const response = await githubFetch(
      token,
      "GET",
      `/repos/${repoFullName}/commits/${encodeURIComponent(headSha)}/check-runs?${query}`,
      undefined,
      signal,
    );
    const data = (await response.json()) as {
      total_count?: number;
      check_runs?: Array<{ id?: number; external_id?: string; name?: string }>;
    };
    const runs = Array.isArray(data.check_runs) ? data.check_runs : [];
    const match = runs.find(
      (run) =>
        Number.isSafeInteger(run.id) && run.name === name && run.external_id === externalId,
    );
    if (match?.id !== undefined) return match.id;
    const totalCount = Number.isSafeInteger(data.total_count) ? data.total_count : undefined;
    if (
      runs.length < CHECK_RUNS_PAGE_SIZE ||
      (totalCount !== undefined && page * CHECK_RUNS_PAGE_SIZE >= totalCount)
    ) {
      return null;
    }
  }
  throw new Error("GitHub check-run reconciliation exceeded its page limit");
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
  for (let page = 1; page <= RESPOND_MARKER_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      per_page: String(ISSUE_COMMENTS_PAGE_SIZE),
      page: String(page),
      since: since.toISOString(),
    });
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
    if (match?.id !== undefined) return match.id;
    if (comments.length < ISSUE_COMMENTS_PAGE_SIZE) return null;
  }
  throw new Error(
    `GitHub comment marker search is inconclusive after ${RESPOND_MARKER_MAX_PAGES} full pages`,
  );
}

export async function getPullRequestHeadSha(
  token: string,
  repoFullName: string,
  number: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await githubFetch(
    token,
    "GET",
    `/repos/${repoFullName}/pulls/${number}`,
    undefined,
    signal,
  );
  const data = (await res.json()) as { head?: { sha?: string } };
  const headSha = data.head?.sha;
  if (!headSha) throw new Error(`GitHub pull request ${repoFullName}#${number} has no head sha`);
  return headSha;
}

export interface PullRequestReviewContext {
  headSha: string;
  baseSha: string;
  draft: boolean;
  authorGithubId?: number;
  authorLogin?: string;
}

/** Load the immutable refs required by the existing review-job payload. */
export async function getPullRequestReviewContext(
  token: string,
  repoFullName: string,
  number: number,
  signal?: AbortSignal,
): Promise<PullRequestReviewContext> {
  const res = await githubFetch(
    token,
    "GET",
    `/repos/${repoFullName}/pulls/${number}`,
    undefined,
    signal,
  );
  const data = (await res.json()) as {
    draft?: boolean;
    head?: { sha?: string };
    base?: { sha?: string };
    user?: { id?: number; login?: string };
  };
  const headSha = data.head?.sha;
  const baseSha = data.base?.sha;
  if (!headSha || !baseSha) {
    throw new Error(`GitHub pull request ${repoFullName}#${number} has incomplete refs`);
  }
  const authorGithubId = data.user?.id;
  const authorLogin = typeof data.user?.login === "string" ? data.user.login.trim() : undefined;
  return {
    headSha,
    baseSha,
    draft: data.draft === true,
    ...(typeof authorGithubId === "number" && Number.isSafeInteger(authorGithubId) && authorGithubId > 0
      ? { authorGithubId }
      : {}),
    ...(authorLogin && authorLogin.length <= 100 ? { authorLogin } : {}),
  };
}
