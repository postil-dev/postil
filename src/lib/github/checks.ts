import { apiBase } from "./app-auth";
import { isPostilBotLogin } from "./conversation";

/**
 * Check-run REST helpers.
 *
 * The worker (not the CLI) creates both check-runs so it owns their ids
 * even if the CLI crashes; the CLI completes them on the happy path. On
 * crash/timeout the worker completes them itself: the review check fails with
 * the operational error summary, while the gate follows organization policy.
 */

export const ADVISORY_CHECK_NAME = "postil/review";
export const GATE_CHECK_NAME = "postil/gate";
export const RESPOND_MARKER_MAX_PAGES = 10;

const ISSUE_COMMENTS_PAGE_SIZE = 100;
const CHECK_RUN_CREATE_TIMEOUT_MS = 10_000;
const CHECK_RUN_COMPLETE_TIMEOUT_MS = 10_000;
const CHECK_RUN_VERIFY_TIMEOUT_MS = 10_000;
const CHECK_RUN_RECONCILE_TIMEOUT_MS = 5_000;
const CHECK_RUNS_PAGE_SIZE = 100;
const CHECK_RUNS_MAX_PAGES = 10;

type Conclusion = "success" | "failure" | "neutral";

export interface ExpectedCheckRunIdentity {
  id: number;
  name: string;
  externalId: string;
  headSha: string;
  detailsUrl?: string;
}

export interface ExpectedCompletedCheckRun extends ExpectedCheckRunIdentity {
  conclusion: Conclusion;
  requireOutput?: boolean;
}

interface CheckRunSnapshot {
  id?: number;
  name?: string;
  external_id?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
  };
}

export class CheckRunPublicationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CheckRunPublicationError";
  }
}

export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubHttpError";
  }
}

export type GithubCommentKind = "issue_comment" | "pull_request_review_comment";
export type CommentReaction = "+1" | "eyes";
export type PullRequestReviewReactionContent = "+1" | "-1";

export interface PullRequestReviewCommentReaction {
  id: number;
  content: PullRequestReviewReactionContent;
  createdAt: Date;
  user: { id: number; login: string; type?: string };
}

export interface PullRequestReviewComment {
  id: number;
  body: string;
  userLogin?: string;
  inReplyToId?: number;
}

/**
 * Add the App's acknowledgement to the exact comment that requested work.
 * GitHub treats an identical reaction by the same user as idempotent, so a
 * queue retry after an ambiguous response cannot create another reaction.
 */
export async function addCommentReaction(
  token: string,
  repoFullName: string,
  commentId: number,
  commentKind: GithubCommentKind,
  content: CommentReaction,
  signal?: AbortSignal,
): Promise<"created" | "already_exists" | "missing"> {
  const collection = commentKind === "issue_comment" ? "issues" : "pulls";
  try {
    const response = await githubFetch(
      token,
      "POST",
      `/repos/${repoFullName}/${collection}/comments/${commentId}/reactions`,
      { content },
      signal ?? AbortSignal.timeout(10_000),
    );
    return response.status === 200 ? "already_exists" : "created";
  } catch (error) {
    // A deleted source comment has nothing left to acknowledge. Treat it as
    // reconciled rather than retrying a permanent absence forever.
    if (error instanceof GitHubHttpError && error.status === 404) return "missing";
    throw error;
  }
}

/** Load the root review comment before accepting an unmentioned thread reply. */
export async function getPullRequestReviewComment(
  token: string,
  repoFullName: string,
  commentId: number,
  signal?: AbortSignal,
): Promise<PullRequestReviewComment> {
  const response = await githubFetch(
    token,
    "GET",
    `/repos/${repoFullName}/pulls/comments/${commentId}`,
    undefined,
    signal,
  );
  const value = (await response.json()) as {
    id?: number;
    body?: string;
    user?: { login?: string };
    in_reply_to_id?: number;
  };
  if (!Number.isSafeInteger(value.id) || typeof value.body !== "string") {
    throw new Error("GitHub review comment response is malformed");
  }
  return {
    id: value.id!,
    body: value.body,
    ...(value.user?.login ? { userLogin: value.user.login } : {}),
    ...(Number.isSafeInteger(value.in_reply_to_id)
      ? { inReplyToId: value.in_reply_to_id }
      : {}),
  };
}

/** Read every bounded page of reactions for one immutable pull-request review comment. */
export async function listPullRequestReviewCommentReactions(
  token: string,
  repoFullName: string,
  commentId: number,
  signal?: AbortSignal,
): Promise<PullRequestReviewCommentReaction[]> {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new Error("GitHub review comment reaction identity is malformed");
  }
  const contents: readonly PullRequestReviewReactionContent[] = ["+1", "-1"];
  const reactions: PullRequestReviewCommentReaction[] = [];
  const maxPages = 5;
  const perPage = 100;
  for (const content of contents) {
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ content, per_page: String(perPage), page: String(page) });
      const response = await githubFetch(
        token,
        "GET",
        `/repos/${repoFullName}/pulls/comments/${commentId}/reactions?${query}`,
        undefined,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      );
      const values = await response.json() as Array<{
        id?: number;
        content?: string;
        created_at?: string;
        user?: { id?: number; login?: string; type?: string };
      }>;
      if (!Array.isArray(values)) throw new Error("GitHub review comment reactions response is malformed");
      for (const value of values) {
        const createdAt = typeof value.created_at === "string" ? new Date(value.created_at) : null;
        if (
          !Number.isSafeInteger(value.id) || value.id === undefined || value.id <= 0 ||
          value.content !== content ||
          !Number.isSafeInteger(value.user?.id) || value.user?.id === undefined || value.user.id <= 0 ||
          typeof value.user.login !== "string" ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/u.test(value.user.login) ||
          !createdAt || Number.isNaN(createdAt.getTime())
        ) {
          throw new Error("GitHub review comment reactions response is malformed");
        }
        reactions.push({
          id: value.id,
          content,
          createdAt,
          user: { id: value.user.id, login: value.user.login, ...(value.user.type ? { type: value.user.type } : {}) },
        });
      }
      if (values.length < perPage) break;
      if (page === maxPages) {
        throw new Error(`GitHub review comment reactions exceeded ${maxPages} pages for ${content}`);
      }
    }
  }
  return reactions;
}

export class AmbiguousCheckRunCreationError extends Error {
  constructor(
    readonly externalId: string,
    cause: unknown,
  ) {
    super(`GitHub check-run creation is ambiguous for ${externalId}`, {
      cause,
    });
    this.name = "AmbiguousCheckRunCreationError";
  }
}

async function githubFetch(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
  options: { signal?: AbortSignal; externalId?: string; detailsUrl?: string } = {},
): Promise<number> {
  const requestSignal = options.signal
    ? AbortSignal.any([
        options.signal,
        AbortSignal.timeout(CHECK_RUN_CREATE_TIMEOUT_MS),
      ])
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
        ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
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
        Number.isSafeInteger(run.id) &&
        run.name === name &&
        run.external_id === externalId,
    );
    if (match?.id !== undefined) return match.id;
    const totalCount = Number.isSafeInteger(data.total_count)
      ? data.total_count
      : undefined;
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
  detailsUrl?: string,
): Promise<void> {
  const requestSignal = signal
    ? AbortSignal.any([
        signal,
        AbortSignal.timeout(CHECK_RUN_COMPLETE_TIMEOUT_MS),
      ])
    : AbortSignal.timeout(CHECK_RUN_COMPLETE_TIMEOUT_MS);
  await githubFetch(
    token,
    "PATCH",
    `/repos/${repoFullName}/check-runs/${checkRunId}`,
    {
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion,
      output: { title, summary },
      ...(detailsUrl ? { details_url: detailsUrl } : {}),
    },
    requestSignal,
  );
}

async function loadCheckRun(
  token: string,
  repoFullName: string,
  checkRunId: number,
  signal?: AbortSignal,
): Promise<CheckRunSnapshot> {
  const requestSignal = signal
    ? AbortSignal.any([
        signal,
        AbortSignal.timeout(CHECK_RUN_VERIFY_TIMEOUT_MS),
      ])
    : AbortSignal.timeout(CHECK_RUN_VERIFY_TIMEOUT_MS);
  const response = await githubFetch(
    token,
    "GET",
    `/repos/${repoFullName}/check-runs/${checkRunId}`,
    undefined,
    requestSignal,
  );
  return (await response.json()) as CheckRunSnapshot;
}

function assertCheckRunIdentity(
  run: CheckRunSnapshot,
  expected: ExpectedCheckRunIdentity,
): void {
  if (
    run.id !== expected.id ||
    run.name !== expected.name ||
    run.external_id !== expected.externalId ||
    run.head_sha !== expected.headSha
  ) {
    throw new CheckRunPublicationError(
      `GitHub check-run ${expected.id} does not match its review identity`,
    );
  }
}

/** Load one check run and prove it belongs to the expected review snapshot. */
export async function verifyCheckRunIdentity(
  token: string,
  repoFullName: string,
  expected: ExpectedCheckRunIdentity,
  signal?: AbortSignal,
): Promise<{
  status?: string;
  conclusion?: string | null;
  title?: string | null;
  summary?: string | null;
  detailsUrl?: string | null;
}> {
  const run = await loadCheckRun(token, repoFullName, expected.id, signal);
  assertCheckRunIdentity(run, expected);
  return {
    status: run.status,
    conclusion: run.conclusion,
    title: run.output?.title,
    summary: run.output?.summary,
    detailsUrl: run.details_url,
  };
}

/**
 * Verify the exact check-run publication owned by one hosted review. A CLI
 * exit code describes the review verdict, not whether GitHub accepted the
 * publication, so the worker treats this forge postcondition as mandatory.
 */
export async function verifyCompletedCheckRun(
  token: string,
  repoFullName: string,
  expected: ExpectedCompletedCheckRun,
  signal?: AbortSignal,
  expectedOutput?: { title: string; summary: string },
): Promise<void> {
  const run = await loadCheckRun(token, repoFullName, expected.id, signal);
  assertCheckRunIdentity(run, expected);
  if (run.status !== "completed") {
    throw new CheckRunPublicationError(
      `GitHub check-run ${expected.id} is not completed`,
    );
  }
  if (run.conclusion !== expected.conclusion) {
    throw new CheckRunPublicationError(
      `GitHub check-run ${expected.id} concluded ${run.conclusion ?? "without a verdict"}; expected ${expected.conclusion}`,
    );
  }
  if (expected.detailsUrl && run.details_url !== expected.detailsUrl) {
    throw new CheckRunPublicationError(
      `GitHub check-run ${expected.id} does not link to its review details`,
    );
  }
  if (
    expected.requireOutput &&
    (!run.output?.title?.trim() || !run.output?.summary?.trim())
  ) {
    throw new CheckRunPublicationError(
      `GitHub check-run ${expected.id} has no published output`,
    );
  }
  if (
    expectedOutput &&
    (run.output?.title !== expectedOutput.title ||
      run.output?.summary !== expectedOutput.summary)
  ) {
    throw new CheckRunPublicationError(
      `GitHub check-run ${expected.id} did not publish the expected output`,
    );
  }
}

/**
 * Complete a known check run without trusting its numeric id alone. Repeated
 * cleanup attempts observe and accept the exact terminal state instead of
 * issuing another write.
 */
export async function completeExpectedCheckRun(
  token: string,
  repoFullName: string,
  expected: ExpectedCompletedCheckRun,
  title: string,
  summary: string,
  signal?: AbortSignal,
): Promise<void> {
  const existing = await verifyCheckRunIdentity(
    token,
    repoFullName,
    expected,
    signal,
  );
  if (
    existing.status === "completed" &&
    existing.conclusion === expected.conclusion &&
    existing.title === title &&
    existing.summary === summary &&
    (!expected.detailsUrl || existing.detailsUrl === expected.detailsUrl)
  ) {
    return;
  }
  await completeCheckRun(
    token,
    repoFullName,
    expected.id,
    expected.conclusion,
    title,
    summary,
    signal,
    expected.detailsUrl,
  );
  await verifyCompletedCheckRun(token, repoFullName, expected, signal, {
    title,
    summary,
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
  if (!Number.isSafeInteger(data.id))
    throw new Error("GitHub comment response has no valid id");
  return data.id!;
}

/** Reply inside an existing pull-request review thread. */
export async function postPullRequestReviewCommentReply(
  token: string,
  repoFullName: string,
  pullNumber: number,
  rootCommentId: number,
  body: string,
  signal?: AbortSignal,
): Promise<number> {
  const response = await githubFetch(
    token,
    "POST",
    `/repos/${repoFullName}/pulls/${pullNumber}/comments/${rootCommentId}/replies`,
    { body },
    signal,
  );
  const data = (await response.json()) as { id?: number };
  if (!Number.isSafeInteger(data.id)) {
    throw new Error("GitHub review reply response has no valid id");
  }
  return data.id!;
}

/** Remove a comment that GitHub accepted after its publication lease ended. */
export async function deleteIssueComment(
  token: string,
  repoFullName: string,
  commentId: number,
  signal?: AbortSignal,
): Promise<void> {
  await githubFetch(
    token,
    "DELETE",
    `/repos/${repoFullName}/issues/comments/${commentId}`,
    undefined,
    signal,
  );
}

/** Remove a pull-request review reply accepted after its lease ended. */
export async function deletePullRequestReviewComment(
  token: string,
  repoFullName: string,
  commentId: number,
  signal?: AbortSignal,
): Promise<void> {
  await githubFetch(
    token,
    "DELETE",
    `/repos/${repoFullName}/pulls/comments/${commentId}`,
    undefined,
    signal,
  );
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
    const comments = (await response.json()) as Array<{
      id?: number;
      body?: string;
      user?: { login?: string };
    }>;
    const match = comments.find(
      (comment) =>
        Number.isSafeInteger(comment.id) &&
        comment.body?.includes(marker) &&
        isPostilBotLogin(comment.user?.login),
    );
    if (match?.id !== undefined) return match.id;
    if (comments.length < ISSUE_COMMENTS_PAGE_SIZE) return null;
  }
  throw new Error(
    `GitHub comment marker search is inconclusive after ${RESPOND_MARKER_MAX_PAGES} full pages`,
  );
}

/** Find a previously posted inline reply after an ambiguous delivery. */
export async function findPullRequestReviewCommentByMarker(
  token: string,
  repoFullName: string,
  pullNumber: number,
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
      `/repos/${repoFullName}/pulls/${pullNumber}/comments?${query}`,
      undefined,
      signal,
    );
    const comments = (await response.json()) as Array<{
      id?: number;
      body?: string;
      user?: { login?: string };
    }>;
    const match = comments.find(
      (comment) =>
        Number.isSafeInteger(comment.id) &&
        comment.body?.includes(marker) &&
        isPostilBotLogin(comment.user?.login),
    );
    if (match?.id !== undefined) return match.id;
    if (comments.length < ISSUE_COMMENTS_PAGE_SIZE) return null;
  }
  throw new Error(
    `GitHub review comment marker search is inconclusive after ${RESPOND_MARKER_MAX_PAGES} full pages`,
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
  if (!headSha)
    throw new Error(
      `GitHub pull request ${repoFullName}#${number} has no head sha`,
    );
  return headSha;
}

export interface PullRequestReviewContext {
  headSha: string;
  baseSha: string;
  open: boolean;
  merged: boolean;
  draft: boolean;
  updatedAt?: string;
  authorGithubId?: number;
  authorLogin?: string;
}

export type PullRequestUpdatedAt =
  | { kind: "valid"; seconds: number }
  | { kind: "missing" }
  | { kind: "malformed" };

const GITHUB_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/** Classify a GitHub pull-request update timestamp at whole-second precision. */
export function parsePullRequestUpdatedAt(value: unknown): PullRequestUpdatedAt {
  if (value === undefined) return { kind: "missing" };
  if (typeof value !== "string") return { kind: "malformed" };
  const components = GITHUB_TIMESTAMP_PATTERN.exec(value);
  if (!components) return { kind: "malformed" };
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return { kind: "malformed" };
  const parsed = new Date(milliseconds);
  const expected = components.slice(1, 7).map(Number);
  const actual = [
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + 1,
    parsed.getUTCDate(),
    parsed.getUTCHours(),
    parsed.getUTCMinutes(),
    parsed.getUTCSeconds(),
  ];
  if (actual.some((component, index) => component !== expected[index])) {
    return { kind: "malformed" };
  }
  return { kind: "valid", seconds: Math.trunc(milliseconds / 1_000) };
}

export type PullRequestSnapshotOrder =
  | "event_newer"
  | "live_newer"
  | "equal"
  | "unknown";

/** Compare signed-event and live pull-request timestamps at whole-second precision. */
export function comparePullRequestSnapshotTimes(
  eventUpdatedAt: unknown,
  liveUpdatedAt: unknown,
): PullRequestSnapshotOrder {
  const eventTimestamp = parsePullRequestUpdatedAt(eventUpdatedAt);
  const liveTimestamp = parsePullRequestUpdatedAt(liveUpdatedAt);
  if (eventTimestamp.kind !== "valid" || liveTimestamp.kind !== "valid") {
    return "unknown";
  }
  if (eventTimestamp.seconds > liveTimestamp.seconds) return "event_newer";
  if (liveTimestamp.seconds > eventTimestamp.seconds) return "live_newer";
  return "equal";
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
    state?: string;
    merged?: boolean;
    draft?: boolean;
    head?: { sha?: string };
    base?: { sha?: string };
    updated_at?: unknown;
    user?: { id?: number; login?: string };
  };
  const headSha = data.head?.sha;
  const baseSha = data.base?.sha;
  if (!headSha || !baseSha) {
    throw new Error(
      `GitHub pull request ${repoFullName}#${number} has incomplete refs`,
    );
  }
  const authorGithubId = data.user?.id;
  const authorLogin =
    typeof data.user?.login === "string" ? data.user.login.trim() : undefined;
  const updatedAt = parsePullRequestUpdatedAt(data.updated_at);
  return {
    headSha,
    baseSha,
    open: data.state === "open",
    merged: data.merged === true,
    draft: data.draft === true,
    ...(updatedAt.kind === "valid" ? { updatedAt: data.updated_at as string } : {}),
    ...(typeof authorGithubId === "number" &&
    Number.isSafeInteger(authorGithubId) &&
    authorGithubId > 0
      ? { authorGithubId }
      : {}),
    ...(authorLogin && authorLogin.length <= 100 ? { authorLogin } : {}),
  };
}

/**
 * Whether a previously reviewed head can still anchor an incremental diff.
 *
 * The compare's merge base equals the ancestor exactly when that commit is
 * still in the head's history. A rebase or force-push replaces the reviewed
 * commits, the merge base moves, and an incremental diff from the old head
 * would describe changes the pull request no longer contains, so the CLI
 * refuses it and the review fails with no verdict. Checking here lets the
 * worker request a full review instead. `per_page=1` bounds the response
 * size; the merge base is reported regardless of file pagination.
 */
export async function incrementalBaselineUsable(
  token: string,
  repoFullName: string,
  baselineHeadSha: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await githubFetch(
    token,
    "GET",
    `/repos/${repoFullName}/compare/${baselineHeadSha}...${headSha}?per_page=1`,
    undefined,
    signal,
  );
  const data = (await res.json()) as { merge_base_commit?: { sha?: string } };
  return data.merge_base_commit?.sha === baselineHeadSha;
}
