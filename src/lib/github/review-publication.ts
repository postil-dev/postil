import { apiBase } from "@/lib/github/app-auth";
import { isPostilBotLogin } from "@/lib/github/conversation";

const PAGE_SIZE = 25;
const MAX_PAGES = 80;
const MAXIMUM_RESPONSE_BYTES = 16_777_216;
const REQUEST_TIMEOUT_MS = 10_000;

export interface GitHubReviewCommentIntent {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
  marker: string;
}

export interface GitHubCompositeReviewIntent {
  commitId: string;
  body: string;
  marker: string;
  comments: GitHubReviewCommentIntent[];
}

export interface GitHubFileCommentIntent {
  commitId: string;
  path: string;
  body: string;
  marker: string;
}

export interface GitHubReviewObservation {
  reviewId: string;
  commitId: string;
  body: string;
  commentIdsByMarker: Record<string, string>;
  missingCommentMarkers: string[];
}

export interface GitHubFileCommentObservation {
  commentId: string;
  commitId: string;
  path: string;
  body: string;
}

export interface GitHubReviewCommentUpdateIntent {
  commentId: string;
  commitId: string;
  path: string;
  expectedMarkers: string[];
  body: string;
}

export class GitHubReviewPlacementRejectedError extends Error {
  override name = "GitHubReviewPlacementRejectedError";

  constructor() {
    super("GitHub rejected one or more review comment line placements");
  }
}

export class GitHubPublicationAmbiguousError extends Error {
  override name = "GitHubPublicationAmbiguousError";

  constructor(operation: string, options?: ErrorOptions) {
    super(`GitHub ${operation} outcome is ambiguous`, options);
  }
}

export class GitHubPublicationRejectedError extends Error {
  override name = "GitHubPublicationRejectedError";

  constructor(
    operation: string,
    readonly status: number,
  ) {
    super(`GitHub rejected ${operation} with HTTP ${status}`);
  }
}

interface ReviewResponse {
  id?: number;
  body?: string | null;
  commit_id?: string;
  state?: string;
  submitted_at?: string | null;
  user?: { login?: string | null } | null;
}

interface ReviewCommentResponse {
  id?: number;
  body?: string | null;
  commit_id?: string;
  original_commit_id?: string;
  path?: string;
  pull_request_review_id?: number | null;
  subject_type?: string;
  user?: { login?: string | null } | null;
}

/** Publish one submitted composite review and reconcile uncertain writes by marker. */
export async function publishGitHubCompositeReview(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  intent: GitHubCompositeReviewIntent,
  signal?: AbortSignal,
): Promise<GitHubReviewObservation> {
  const path = pullRequestPath(repoFullName, pullRequestNumber);
  validateSha(intent.commitId);
  validateMarker(intent.marker, "review");
  requireMarker(intent.body, intent.marker);
  for (const comment of intent.comments) {
    validateReviewComment(comment);
  }
  validateUniqueFindingMarkers(
    intent.comments.map((comment) => comment.marker),
  );
  signal?.throwIfAborted();

  let response: Response;
  try {
    response = await requestGitHub(
      token,
      "POST",
      `${path}/reviews`,
      {
        commit_id: intent.commitId,
        event: "COMMENT",
        body: intent.body,
        comments: intent.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          ...(comment.startLine === undefined
            ? {}
            : { start_line: comment.startLine }),
          ...(comment.startSide === undefined
            ? {}
            : { start_side: comment.startSide }),
          body: comment.body,
        })),
      },
      signal,
    );
  } catch (error) {
    return reconcileCompositeReview(
      token,
      repoFullName,
      pullRequestNumber,
      intent,
      signal,
      error,
    );
  }

  if (response.ok) {
    try {
      const review = parseReview(
        await readBoundedJson(response),
        intent.commitId,
        intent.marker,
      );
      return await materializeReviewObservation(
        token,
        repoFullName,
        pullRequestNumber,
        review,
        intent.comments.map((comment) => comment.marker),
        signal,
      );
    } catch (error) {
      return reconcileCompositeReview(
        token,
        repoFullName,
        pullRequestNumber,
        intent,
        signal,
        error,
      );
    }
  }

  if (response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return reconcileCompositeReview(
      token,
      repoFullName,
      pullRequestNumber,
      intent,
      signal,
      new GitHubPublicationRejectedError("composite review", response.status),
    );
  }
  if (response.status === 422) {
    const rejection = await readBoundedText(response);
    if (reviewLinePlacementRejected(rejection)) {
      throw new GitHubReviewPlacementRejectedError();
    }
  }
  await response.body?.cancel().catch(() => undefined);
  throw new GitHubPublicationRejectedError("composite review", response.status);
}

/** Find an exact submitted review without treating an absent marker as success. */
export async function findGitHubReviewByMarker(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  marker: string,
  commitId: string,
  signal?: AbortSignal,
): Promise<{ reviewId: string; commitId: string; body: string } | null> {
  validateMarker(marker, "review");
  validateSha(commitId);
  const path = pullRequestPath(repoFullName, pullRequestNumber);
  const matches: Array<{ reviewId: string; commitId: string; body: string }> =
    [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await requestGitHub(
      token,
      "GET",
      `${path}/reviews?per_page=${PAGE_SIZE}&page=${page}`,
      undefined,
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubPublicationRejectedError(
        "review reconciliation",
        response.status,
      );
    }
    const value = await readBoundedJson(response);
    if (!Array.isArray(value)) throw malformedResponse();
    for (const candidate of value) {
      const review = candidate as ReviewResponse;
      if (
        typeof review?.body !== "string" ||
        !review.body.includes(marker) ||
        !isPostilBotLogin(review.user?.login ?? undefined)
      ) {
        continue;
      }
      try {
        matches.push(parseReview(candidate, commitId, marker));
      } catch (error) {
        throw new GitHubPublicationAmbiguousError("review marker identity", {
          cause: error,
        });
      }
    }
    if (!hasNextPage(response)) break;
    if (page === MAX_PAGES) {
      throw new GitHubPublicationAmbiguousError("review marker search");
    }
  }
  if (matches.length > 1) {
    throw new GitHubPublicationAmbiguousError("review marker identity");
  }
  return matches[0] ?? null;
}

/** Replace a review summary only after observing the exact durable identity. */
export async function updateGitHubReviewSummary(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  reviewId: string,
  commitId: string,
  marker: string,
  body: string,
  signal?: AbortSignal,
): Promise<{ reviewId: string; commitId: string; body: string }> {
  validateRemoteId(reviewId);
  validateSha(commitId);
  validateMarker(marker, "review");
  requireMarker(body, marker);
  const current = await getExactReview(
    token,
    repoFullName,
    pullRequestNumber,
    reviewId,
    commitId,
    marker,
    signal,
  );
  if (current.body === body) return current;
  signal?.throwIfAborted();

  const path = `${pullRequestPath(repoFullName, pullRequestNumber)}/reviews/${reviewId}`;
  try {
    const response = await requestGitHub(token, "PUT", path, { body }, signal);
    if (!response.ok && response.status < 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubPublicationRejectedError(
        "review summary update",
        response.status,
      );
    }
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    const reconciled = await getExactReview(
      token,
      repoFullName,
      pullRequestNumber,
      reviewId,
      commitId,
      marker,
      signal,
    ).catch(() => null);
    if (reconciled?.body === body) return reconciled;
    if (error instanceof GitHubPublicationRejectedError) throw error;
    throw new GitHubPublicationAmbiguousError("review summary update", {
      cause: error,
    });
  }
  const verified = await getExactReview(
    token,
    repoFullName,
    pullRequestNumber,
    reviewId,
    commitId,
    marker,
    signal,
  ).catch((error) => {
    throw new GitHubPublicationAmbiguousError("review summary verification", {
      cause: error,
    });
  });
  if (verified.body !== body) {
    throw new GitHubPublicationAmbiguousError("review summary verification");
  }
  return verified;
}

/** Publish one file-level review comment and reconcile uncertain writes by marker. */
export async function publishGitHubFileComment(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  intent: GitHubFileCommentIntent,
  signal?: AbortSignal,
): Promise<GitHubFileCommentObservation> {
  validateSha(intent.commitId);
  validatePath(intent.path);
  validateMarker(intent.marker, "finding");
  requireMarker(intent.body, intent.marker);
  const path = `${pullRequestPath(repoFullName, pullRequestNumber)}/comments`;
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await requestGitHub(
      token,
      "POST",
      path,
      {
        body: intent.body,
        commit_id: intent.commitId,
        path: intent.path,
        subject_type: "file",
      },
      signal,
    );
  } catch (error) {
    return reconcileFileComment(
      token,
      repoFullName,
      pullRequestNumber,
      intent,
      signal,
      error,
    );
  }
  if (response.ok) {
    try {
      return parseFileComment(
        await readBoundedJson(response),
        intent.commitId,
        intent.path,
        intent.marker,
      );
    } catch (error) {
      return reconcileFileComment(
        token,
        repoFullName,
        pullRequestNumber,
        intent,
        signal,
        error,
      );
    }
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return reconcileFileComment(
      token,
      repoFullName,
      pullRequestNumber,
      intent,
      signal,
      new GitHubPublicationRejectedError(
        "file review comment",
        response.status,
      ),
    );
  }
  await response.body?.cancel().catch(() => undefined);
  throw new GitHubPublicationRejectedError(
    "file review comment",
    response.status,
  );
}

/** Replace one owned review comment after observing its exact durable identity. */
export async function updateGitHubReviewComment(
  token: string,
  repoFullName: string,
  intent: GitHubReviewCommentUpdateIntent,
  signal?: AbortSignal,
): Promise<GitHubFileCommentObservation> {
  validateRemoteId(intent.commentId);
  validateSha(intent.commitId);
  validatePath(intent.path);
  validateExpectedMarkers(intent.expectedMarkers);
  requireAnyMarker(intent.body, intent.expectedMarkers);
  const current = await getExactReviewComment(
    token,
    repoFullName,
    intent,
    signal,
  );
  if (current.body === intent.body) return current;
  signal?.throwIfAborted();

  const path = `${repositoryPath(repoFullName)}/pulls/comments/${intent.commentId}`;
  let response: Response;
  try {
    response = await requestGitHub(
      token,
      "PATCH",
      path,
      { body: intent.body },
      signal,
    );
  } catch (error) {
    return reconcileReviewCommentUpdate(
      token,
      repoFullName,
      intent,
      signal,
      error,
    );
  }
  if (response.ok) {
    try {
      const observation = parseReviewComment(
        await readBoundedJson(response),
        intent,
      );
      if (observation.body !== intent.body) {
        throw new GitHubPublicationAmbiguousError(
          "review comment update verification",
        );
      }
      return observation;
    } catch (error) {
      return reconcileReviewCommentUpdate(
        token,
        repoFullName,
        intent,
        signal,
        error,
      );
    }
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status < 500) {
    throw new GitHubPublicationRejectedError(
      "review comment update",
      response.status,
    );
  }
  return reconcileReviewCommentUpdate(
    token,
    repoFullName,
    intent,
    signal,
    new GitHubPublicationRejectedError(
      "review comment update",
      response.status,
    ),
  );
}

async function reconcileCompositeReview(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  intent: GitHubCompositeReviewIntent,
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<GitHubReviewObservation> {
  try {
    const review = await findGitHubReviewByMarker(
      token,
      repoFullName,
      pullRequestNumber,
      intent.marker,
      intent.commitId,
      signal,
    );
    if (!review) {
      throw new GitHubPublicationAmbiguousError("composite review", { cause });
    }
    return await materializeReviewObservation(
      token,
      repoFullName,
      pullRequestNumber,
      review,
      intent.comments.map((comment) => comment.marker),
      signal,
    );
  } catch (error) {
    if (
      error instanceof GitHubPublicationAmbiguousError &&
      error.message === "GitHub composite review outcome is ambiguous"
    ) {
      throw error;
    }
    throw new GitHubPublicationAmbiguousError("composite review", {
      cause: error,
    });
  }
}

async function materializeReviewObservation(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  review: { reviewId: string; commitId: string; body: string },
  expectedCommentMarkers: string[],
  signal?: AbortSignal,
): Promise<GitHubReviewObservation> {
  validateUniqueFindingMarkers(expectedCommentMarkers);
  const comments = await listReviewComments(
    token,
    repoFullName,
    pullRequestNumber,
    review.reviewId,
    expectedCommentMarkers,
    signal,
  );
  const commentIdsByMarker: Record<string, string> = {};
  const missingCommentMarkers: string[] = [];
  const claimedCommentIds = new Set<string>();
  for (const marker of expectedCommentMarkers) {
    const matches = comments.filter(
      (comment) =>
        typeof comment.body === "string" &&
        comment.body.includes(marker) &&
        isPostilBotLogin(comment.user?.login ?? undefined),
    );
    for (const comment of matches) {
      if (
        !Number.isSafeInteger(comment.id) ||
        comment.id! <= 0 ||
        comment.original_commit_id !== review.commitId ||
        !Number.isSafeInteger(comment.pull_request_review_id) ||
        String(comment.pull_request_review_id) !== review.reviewId
      ) {
        throw new GitHubPublicationAmbiguousError(
          "review comment marker identity",
        );
      }
    }
    if (matches.length > 1) {
      throw new GitHubPublicationAmbiguousError(
        "review comment marker identity",
      );
    }
    const commentId = matches[0]?.id;
    if (commentId === undefined) {
      missingCommentMarkers.push(marker);
      continue;
    }
    const remoteId = String(commentId);
    if (claimedCommentIds.has(remoteId)) {
      throw new GitHubPublicationAmbiguousError(
        "review comment marker identity",
      );
    }
    claimedCommentIds.add(remoteId);
    commentIdsByMarker[marker] = remoteId;
  }
  return {
    ...review,
    commentIdsByMarker,
    missingCommentMarkers,
  };
}

async function listReviewComments(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  reviewId: string,
  expectedMarkers: string[],
  signal?: AbortSignal,
): Promise<ReviewCommentResponse[]> {
  validateRemoteId(reviewId);
  const path = `${pullRequestPath(repoFullName, pullRequestNumber)}/reviews/${reviewId}/comments`;
  const comments: ReviewCommentResponse[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await requestGitHub(
      token,
      "GET",
      `${path}?per_page=${PAGE_SIZE}&page=${page}`,
      undefined,
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubPublicationRejectedError(
        "review comment observation",
        response.status,
      );
    }
    const value = await readBoundedJson(response);
    if (!Array.isArray(value)) throw malformedResponse();
    comments.push(
      ...(value as ReviewCommentResponse[]).filter(
        (comment) =>
          typeof comment?.body === "string" &&
          expectedMarkers.some((marker) => comment.body!.includes(marker)) &&
          isPostilBotLogin(comment.user?.login ?? undefined),
      ),
    );
    if (!hasNextPage(response)) return comments;
  }
  throw new GitHubPublicationAmbiguousError("review comment pagination");
}

async function reconcileFileComment(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  intent: GitHubFileCommentIntent,
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<GitHubFileCommentObservation> {
  const path = `${pullRequestPath(repoFullName, pullRequestNumber)}/comments`;
  const matches: GitHubFileCommentObservation[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await requestGitHub(
        token,
        "GET",
        `${path}?sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`,
        undefined,
        signal,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GitHubPublicationRejectedError(
          "file comment reconciliation",
          response.status,
        );
      }
      const value = await readBoundedJson(response);
      if (!Array.isArray(value)) throw malformedResponse();
      for (const candidate of value) {
        const comment = candidate as ReviewCommentResponse;
        if (
          Number.isSafeInteger(comment.id) &&
          comment.id! > 0 &&
          comment.original_commit_id === intent.commitId &&
          comment.path === intent.path &&
          comment.subject_type === "file" &&
          typeof comment.body === "string" &&
          comment.body.includes(intent.marker) &&
          isPostilBotLogin(comment.user?.login ?? undefined)
        ) {
          matches.push({
            commentId: String(comment.id),
            commitId: comment.original_commit_id,
            path: comment.path,
            body: comment.body,
          });
        }
      }
      if (!hasNextPage(response)) break;
      if (page === MAX_PAGES) {
        throw new GitHubPublicationAmbiguousError("file comment marker search");
      }
    }
  } catch (error) {
    if (error instanceof GitHubPublicationAmbiguousError) throw error;
    throw new GitHubPublicationAmbiguousError("file comment reconciliation", {
      cause: error,
    });
  }
  if (matches.length === 1) return matches[0]!;
  throw new GitHubPublicationAmbiguousError("file review comment", { cause });
}

async function reconcileReviewCommentUpdate(
  token: string,
  repoFullName: string,
  intent: GitHubReviewCommentUpdateIntent,
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<GitHubFileCommentObservation> {
  const observation = await getExactReviewComment(
    token,
    repoFullName,
    intent,
    signal,
  ).catch(() => null);
  if (observation?.body === intent.body) return observation;
  if (cause instanceof GitHubPublicationRejectedError && cause.status < 500) {
    throw cause;
  }
  throw new GitHubPublicationAmbiguousError("review comment update", {
    cause,
  });
}

async function getExactReviewComment(
  token: string,
  repoFullName: string,
  intent: GitHubReviewCommentUpdateIntent,
  signal?: AbortSignal,
): Promise<GitHubFileCommentObservation> {
  const response = await requestGitHub(
    token,
    "GET",
    `${repositoryPath(repoFullName)}/pulls/comments/${intent.commentId}`,
    undefined,
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubPublicationRejectedError(
      "review comment observation",
      response.status,
    );
  }
  return parseReviewComment(await readBoundedJson(response), intent);
}

async function getExactReview(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  reviewId: string,
  commitId: string,
  marker: string,
  signal?: AbortSignal,
): Promise<{ reviewId: string; commitId: string; body: string }> {
  const response = await requestGitHub(
    token,
    "GET",
    `${pullRequestPath(repoFullName, pullRequestNumber)}/reviews/${reviewId}`,
    undefined,
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubPublicationRejectedError(
      "review observation",
      response.status,
    );
  }
  return parseReview(await readBoundedJson(response), commitId, marker);
}

function parseReview(
  value: unknown,
  commitId: string,
  marker: string,
): { reviewId: string; commitId: string; body: string } {
  const review = value as ReviewResponse;
  if (
    !Number.isSafeInteger(review?.id) ||
    review.id! <= 0 ||
    review.commit_id !== commitId ||
    review.state !== "COMMENTED" ||
    typeof review.submitted_at !== "string" ||
    !Number.isFinite(Date.parse(review.submitted_at)) ||
    typeof review.body !== "string" ||
    !review.body.includes(marker) ||
    !isPostilBotLogin(review.user?.login ?? undefined)
  ) {
    throw malformedResponse();
  }
  return {
    reviewId: String(review.id),
    commitId: review.commit_id,
    body: review.body,
  };
}

function parseFileComment(
  value: unknown,
  commitId: string,
  path: string,
  marker: string,
): GitHubFileCommentObservation {
  const comment = value as ReviewCommentResponse;
  if (
    !Number.isSafeInteger(comment?.id) ||
    comment.id! <= 0 ||
    comment.original_commit_id !== commitId ||
    comment.path !== path ||
    comment.subject_type !== "file" ||
    typeof comment.body !== "string" ||
    !comment.body.includes(marker) ||
    !isPostilBotLogin(comment.user?.login ?? undefined)
  ) {
    throw malformedResponse();
  }
  return {
    commentId: String(comment.id),
    commitId: comment.original_commit_id,
    path: comment.path,
    body: comment.body,
  };
}

function parseReviewComment(
  value: unknown,
  intent: GitHubReviewCommentUpdateIntent,
): GitHubFileCommentObservation {
  const comment = value as ReviewCommentResponse;
  if (
    !Number.isSafeInteger(comment?.id) ||
    String(comment.id) !== intent.commentId ||
    comment.original_commit_id !== intent.commitId ||
    comment.path !== intent.path ||
    typeof comment.body !== "string" ||
    !intent.expectedMarkers.some((marker) => comment.body!.includes(marker)) ||
    !isPostilBotLogin(comment.user?.login ?? undefined)
  ) {
    throw malformedResponse();
  }
  return {
    commentId: String(comment.id),
    commitId: comment.original_commit_id,
    path: comment.path,
    body: comment.body,
  };
}

async function requestGitHub(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "postil-control-plane",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAXIMUM_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw malformedResponse();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw malformedResponse();
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw malformedResponse();
  }
}

function hasNextPage(response: Response): boolean {
  const link = response.headers.get("link");
  return link?.split(",").some((part) => /;\s*rel="next"(?:\s*;|\s*$)/.test(part)) ?? false;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const source = await readBoundedText(response);
  try {
    return JSON.parse(source);
  } catch {
    throw malformedResponse();
  }
}

function reviewLinePlacementRejected(source: string): boolean {
  const normalized = source.toLowerCase();
  if (
    normalized.includes("line could not be resolved") ||
    normalized.includes("line must be part of the diff")
  ) {
    return true;
  }
  try {
    const value = JSON.parse(source) as {
      errors?: Array<{ field?: unknown; code?: unknown }>;
    };
    return (
      Array.isArray(value.errors) &&
      value.errors.some(
        (error) =>
          (error.field === "line" || error.field === "start_line") &&
          error.code === "invalid",
      )
    );
  } catch {
    return false;
  }
}

function validateReviewComment(comment: GitHubReviewCommentIntent): void {
  validatePath(comment.path);
  validateMarker(comment.marker, "finding");
  requireMarker(comment.body, comment.marker);
  if (!Number.isSafeInteger(comment.line) || comment.line <= 0)
    throw invalidIntent();
  if (
    comment.startLine !== undefined &&
    (!Number.isSafeInteger(comment.startLine) ||
      comment.startLine <= 0 ||
      comment.startLine > comment.line)
  ) {
    throw invalidIntent();
  }
  if ((comment.startLine === undefined) !== (comment.startSide === undefined)) {
    throw invalidIntent();
  }
}

function pullRequestPath(
  repoFullName: string,
  pullRequestNumber: number,
): string {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw invalidIntent();
  }
  return `${repositoryPath(repoFullName)}/pulls/${pullRequestNumber}`;
}

function repositoryPath(repoFullName: string): string {
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra) throw invalidIntent();
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function validateMarker(marker: string, kind: "review" | "finding"): void {
  const pattern = new RegExp(
    `^<!-- postil-${kind}:v[1-9][0-9]{0,8}:[0-9a-f]{12,64} -->$`,
  );
  if (!pattern.test(marker)) throw invalidIntent();
}

function requireMarker(body: string, marker: string): void {
  if (
    typeof body !== "string" ||
    body.length === 0 ||
    Buffer.byteLength(body) > 65_536 ||
    !body.includes(marker)
  ) {
    throw invalidIntent();
  }
}

function validateExpectedMarkers(markers: string[]): void {
  if (markers.length === 0 || new Set(markers).size !== markers.length) {
    throw invalidIntent();
  }
  for (const marker of markers) validateMarker(marker, "finding");
}

function validateUniqueFindingMarkers(markers: string[]): void {
  if (new Set(markers).size !== markers.length) throw invalidIntent();
  for (const marker of markers) validateMarker(marker, "finding");
}

function requireAnyMarker(body: string, markers: string[]): void {
  if (
    typeof body !== "string" ||
    body.length === 0 ||
    Buffer.byteLength(body) > 65_536 ||
    !markers.some((marker) => body.includes(marker))
  ) {
    throw invalidIntent();
  }
}

function validatePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path) > 1_024 ||
    path.includes("\0")
  ) {
    throw invalidIntent();
  }
}

function validateSha(sha: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw invalidIntent();
}

function validateRemoteId(value: string): void {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw invalidIntent();
}

function invalidIntent(): Error {
  return new Error("GitHub publication intent is invalid");
}

function malformedResponse(): Error {
  return new Error("GitHub publication response is malformed");
}
