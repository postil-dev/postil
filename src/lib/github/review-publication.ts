import { apiBase } from "@/lib/github/app-auth";
import { isPostilBotLogin } from "@/lib/github/conversation";
import { isValidGitHubRepositoryFullName } from "@/lib/github/repository-identity";

const PAGE_SIZE = 25;
const MAX_PAGES = 80;
const MAX_FINDINGS = 64;
const MAX_MARKERS = 16;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_CHECK_SUMMARY_BYTES = 65_535;
const MAX_AGGREGATE_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const MAX_DETAILS_URL_BYTES = 2_048;
const MAX_ANNOTATIONS_PER_REQUEST = 50;
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
  compatibleMarkers?: readonly string[];
}

export interface GitHubCompositeReviewIntent {
  commitId: string;
  body: string;
  marker: string;
  compatibleMarkers?: readonly string[];
  comments: GitHubReviewCommentIntent[];
}

export interface GitHubFileCommentIntent {
  commitId: string;
  path: string;
  body: string;
  marker: string;
  compatibleMarkers?: readonly string[];
}

export interface GitHubFindingMarkerSet {
  marker: string;
  compatibleMarkers?: readonly string[];
}

export interface GitHubReviewObservation {
  reviewId: string;
  commitId: string;
  body: string;
  commentIdsByMarker: Record<string, string>;
  missingCommentMarkers: string[];
}

export interface GitHubReviewIdentityObservation {
  reviewId: string;
  commitId: string;
  body: string;
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
  expectedMarkers: readonly string[];
  body: string;
}

export type GitHubCheckRunName = "postil/review" | "postil/gate";
export type GitHubCheckRunConclusion = "success" | "failure" | "neutral";

export interface GitHubCheckRunStartIntent {
  readonly appId: number;
  readonly name: GitHubCheckRunName;
  readonly headSha: string;
  readonly externalId: string;
  readonly detailsUrl?: string;
}

export interface GitHubCheckRunAnnotationIntent {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly annotationLevel: "notice" | "warning" | "failure";
  readonly message: string;
  readonly title?: string;
  readonly rawDetails?: string;
  readonly startColumn?: number;
  readonly endColumn?: number;
}

export interface GitHubCheckRunCompletionIntent
  extends GitHubCheckRunStartIntent {
  readonly checkRunId: string;
  readonly conclusion: GitHubCheckRunConclusion;
  readonly title: string;
  readonly summary: string;
  readonly annotations?: readonly GitHubCheckRunAnnotationIntent[];
}

export interface GitHubCheckRunObservation {
  readonly checkRunId: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface GitHubCheckRunCompletionObservation
  extends GitHubCheckRunObservation {
  readonly desiredState: "applied" | "retryable" | "conflict";
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

interface CheckRunResponse {
  id?: number;
  name?: string;
  external_id?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string | null;
  app?: { id?: number; slug?: string | null } | null;
  output?: {
    title?: string | null;
    summary?: string | null;
  } | null;
}

interface CheckRunAnnotationResponse {
  path?: string;
  start_line?: number;
  end_line?: number;
  annotation_level?: string;
  message?: string;
  title?: string | null;
  raw_details?: string | null;
  start_column?: number | null;
  end_column?: number | null;
}

interface NormalizedCheckRunAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  annotationLevel: "notice" | "warning" | "failure";
  message: string;
  title: string | null;
  rawDetails: string | null;
  startColumn: number | null;
  endColumn: number | null;
}

interface GitHubAppIdentity {
  id: number;
}

interface NormalizedMarkerSet {
  marker: string;
  markers: readonly string[];
}

/** Create one owned in-progress check run and reconcile an uncertain POST. */
export async function createGitHubCheckRun(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunStartIntent,
  signal?: AbortSignal,
): Promise<string> {
  validateCheckRunStartIntent(intent);
  const githubApp = configuredGithubAppIdentity(intent);
  const path = `${repositoryPath(repoFullName)}/check-runs`;
  signal?.throwIfAborted();

  let response: Response;
  try {
    response = await requestGitHub(
      token,
      "POST",
      path,
      {
        name: intent.name,
        head_sha: intent.headSha,
        status: "in_progress",
        external_id: intent.externalId,
        ...(intent.detailsUrl === undefined
          ? {}
          : { details_url: intent.detailsUrl }),
      },
      signal,
    );
  } catch (error) {
    return reconcileCheckRunCreation(
      token,
      repoFullName,
      intent,
      githubApp,
      signal,
      error,
    );
  }

  if (response.ok) {
    try {
      return parseStartedCheckRun(
        await readBoundedJson(response),
        intent,
        githubApp,
      );
    } catch (error) {
      return reconcileCheckRunCreation(
        token,
        repoFullName,
        intent,
        githubApp,
        signal,
        error,
      );
    }
  }

  await response.body?.cancel().catch(() => undefined);
  if (response.status < 500) {
    throw new GitHubPublicationRejectedError("check-run creation", response.status);
  }
  return reconcileCheckRunCreation(
    token,
    repoFullName,
    intent,
    githubApp,
    signal,
    new GitHubPublicationRejectedError("check-run creation", response.status),
  );
}

/** Find one exact owned check run, returning null only for proven absence. */
export async function findGitHubCheckRunByExternalId(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunStartIntent,
  signal?: AbortSignal,
): Promise<GitHubCheckRunObservation | null> {
  validateCheckRunStartIntent(intent);
  const githubApp = configuredGithubAppIdentity(intent);
  const matches = await listExactCheckRuns(
    token,
    repoFullName,
    intent,
    githubApp,
    signal,
  );
  const run = matches[0];
  return run === undefined
    ? null
    : {
        checkRunId: String(run.id),
        status: run.status ?? "",
        conclusion: run.conclusion ?? null,
      };
}

/** Observe whether one owned check run has the requested terminal state. */
export async function observeGitHubCheckRunCompletion(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  signal?: AbortSignal,
): Promise<GitHubCheckRunCompletionObservation> {
  validateCheckRunCompletionIntent(intent);
  const githubApp = configuredGithubAppIdentity(intent);
  const { run, annotations } = await observeExactCheckRunCompletion(
    token,
    repoFullName,
    intent,
    githubApp,
    signal,
  );
  return {
    checkRunId: String(run.id),
    status: run.status ?? "",
    conclusion: run.conclusion ?? null,
    desiredState: classifyCheckRunCompletion(run, annotations, intent),
  };
}

/** Complete one owned check run with resumable annotation batches. */
export async function completeGitHubCheckRun(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  signal?: AbortSignal,
): Promise<void> {
  validateCheckRunCompletionIntent(intent);
  const githubApp = configuredGithubAppIdentity(intent);
  signal?.throwIfAborted();
  const observed = await observeExactCheckRunCompletion(
    token,
    repoFullName,
    intent,
    githubApp,
    signal,
  );
  const annotations = intent.annotations ?? [];
  const desiredAnnotations = normalizeCheckRunAnnotations(annotations);
  const observedState = classifyCheckRunCompletion(
    observed.run,
    observed.annotations,
    intent,
  );
  if (observedState === "applied") return;
  if (observedState === "conflict") {
    throw new GitHubPublicationAmbiguousError("check-run completion terminal state");
  }

  let publishedAnnotationCount = observed.annotations.length;
  while (true) {
    signal?.throwIfAborted();
    const remaining = annotations.slice(publishedAnnotationCount);
    const finalPayload = buildCheckRunPatch(intent, remaining, true);
    if (
      remaining.length <= MAX_ANNOTATIONS_PER_REQUEST &&
      serializedJsonByteLength(finalPayload) <= MAX_REQUEST_BYTES
    ) {
      await completeGitHubCheckRunWithPayload(
        token,
        repoFullName,
        intent,
        githubApp,
        finalPayload,
        signal,
      );
      return;
    }

    const chunk = largestCheckRunAnnotationChunk(intent, remaining);
    const expectedPrefix = desiredAnnotations.slice(
      0,
      publishedAnnotationCount + chunk.length,
    );
    await appendGitHubCheckRunAnnotations(
      token,
      repoFullName,
      intent,
      githubApp,
      chunk,
      expectedPrefix,
      signal,
    );
    publishedAnnotationCount += chunk.length;
  }
}

async function completeGitHubCheckRunWithPayload(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  githubApp: GitHubAppIdentity,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();

  const path = `${repositoryPath(repoFullName)}/check-runs/${intent.checkRunId}`;
  let response: Response;
  try {
    response = await requestGitHub(
      token,
      "PATCH",
      path,
      payload,
      signal,
    );
  } catch (error) {
    return reconcileCheckRunCompletion(
      token,
      repoFullName,
      intent,
      githubApp,
      signal,
      error,
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 500) {
      throw new GitHubPublicationRejectedError(
        "check-run completion",
        response.status,
      );
    }
    return reconcileCheckRunCompletion(
      token,
      repoFullName,
      intent,
      githubApp,
      signal,
      new GitHubPublicationRejectedError("check-run completion", response.status),
    );
  }

  try {
    const patched = parseExactCheckRun(
      await readBoundedJson(response),
      intent,
      githubApp,
    );
    if (!isExactCompletedCheckRun(patched, intent)) throw malformedResponse();
  } catch (error) {
    return reconcileCheckRunCompletion(
      token,
      repoFullName,
      intent,
      githubApp,
      signal,
      error,
    );
  }

  try {
    await verifyExactCompletedCheckRun(
      token,
      repoFullName,
      intent,
      githubApp,
      signal,
    );
  } catch (error) {
    throw new GitHubPublicationAmbiguousError("check-run completion verification", {
      cause: error,
    });
  }
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
  const reviewMarkers = validateMarkerSet(
    intent.marker,
    intent.compatibleMarkers,
    "review",
  );
  requireAnyMarker(intent.body, reviewMarkers);
  if (!Array.isArray(intent.comments) || intent.comments.length > MAX_FINDINGS) {
    throw invalidIntent();
  }
  for (const comment of intent.comments) {
    validateReviewComment(comment);
  }
  const commentMarkerSets = validateUniqueFindingMarkerSets(intent.comments);
  validateAggregateTextBytes([
    intent.body,
    ...intent.comments.map((comment) => comment.body),
  ]);
  const payload = {
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
  };
  requireSerializedRequestWithinLimit(payload);
  signal?.throwIfAborted();

  let response: Response;
  try {
    response = await requestGitHub(
      token,
      "POST",
      `${path}/reviews`,
      payload,
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
        reviewMarkers,
      );
      return await materializeReviewObservation(
        token,
        repoFullName,
        pullRequestNumber,
        review,
        commentMarkerSets,
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
): Promise<GitHubReviewIdentityObservation | null> {
  return findGitHubReviewByMarkers(
    token,
    repoFullName,
    pullRequestNumber,
    [marker],
    commitId,
    signal,
  );
}

/** Find one submitted review across one compatible marker set. */
export async function findGitHubReviewByMarkers(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  markers: readonly string[],
  commitId: string,
  signal?: AbortSignal,
): Promise<GitHubReviewIdentityObservation | null> {
  validateMarkerList(markers, "review");
  validateSha(commitId);
  const path = pullRequestPath(repoFullName, pullRequestNumber);
  let match: GitHubReviewIdentityObservation | undefined;
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
        !includesAnyMarker(review.body, markers) ||
        !isPostilBotLogin(review.user?.login ?? undefined)
      ) {
        continue;
      }
      try {
        if (match !== undefined) {
          throw new GitHubPublicationAmbiguousError("review marker identity");
        }
        match = parseReview(candidate, commitId, markers);
      } catch (error) {
        if (error instanceof GitHubPublicationAmbiguousError) throw error;
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
  return match ?? null;
}

/** Observe one exact composite review and its compatible finding identities. */
export async function observeGitHubCompositeReviewByMarkers(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  reviewMarkers: readonly string[],
  commitId: string,
  expectedCommentMarkers: readonly (string | GitHubFindingMarkerSet)[],
  signal?: AbortSignal,
): Promise<GitHubReviewObservation | null> {
  const markerSets = validateExpectedCommentMarkerSets(expectedCommentMarkers);
  const review = await findGitHubReviewByMarkers(
    token,
    repoFullName,
    pullRequestNumber,
    reviewMarkers,
    commitId,
    signal,
  );
  if (review === null) return null;
  return materializeReviewObservation(
    token,
    repoFullName,
    pullRequestNumber,
    review,
    markerSets,
    signal,
  );
}

/** Observe one exact composite review by its released primary marker. */
export async function observeGitHubCompositeReviewByMarker(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  marker: string,
  commitId: string,
  expectedCommentMarkers: readonly (string | GitHubFindingMarkerSet)[],
  signal?: AbortSignal,
): Promise<GitHubReviewObservation | null> {
  return observeGitHubCompositeReviewByMarkers(
    token,
    repoFullName,
    pullRequestNumber,
    [marker],
    commitId,
    expectedCommentMarkers,
    signal,
  );
}

/** Replace a review summary only after observing the exact durable identity. */
export async function updateGitHubReviewSummary(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  reviewId: string,
  commitId: string,
  marker: string | readonly string[],
  body: string,
  signal?: AbortSignal,
): Promise<GitHubReviewIdentityObservation> {
  validateRemoteId(reviewId);
  validateSha(commitId);
  const markers = typeof marker === "string" ? [marker] : marker;
  validateMarkerList(markers, "review");
  requireAnyMarker(body, markers);
  const current = await getExactReview(
    token,
    repoFullName,
    pullRequestNumber,
    reviewId,
    commitId,
    markers,
    signal,
  );
  if (current.body === body) return current;
  signal?.throwIfAborted();

  const path = `${pullRequestPath(repoFullName, pullRequestNumber)}/reviews/${reviewId}`;
  try {
    const response = await requestGitHub(token, "PUT", path, { body }, signal);
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok && response.status < 500) {
      throw new GitHubPublicationRejectedError(
        "review summary update",
        response.status,
      );
    }
  } catch (error) {
    const reconciled = await getExactReview(
      token,
      repoFullName,
      pullRequestNumber,
      reviewId,
      commitId,
      markers,
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
    markers,
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
  const markers = validateMarkerSet(
    intent.marker,
    intent.compatibleMarkers,
    "finding",
  );
  requireAnyMarker(intent.body, markers);
  validateAggregateTextBytes([intent.body]);
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
        markers,
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

/** Find one exact owned file comment, returning null only for proven absence. */
export async function findGitHubFileCommentByMarker(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  intent: GitHubFileCommentIntent,
  signal?: AbortSignal,
): Promise<GitHubFileCommentObservation | null> {
  return findGitHubFileCommentByMarkers(
    token,
    repoFullName,
    pullRequestNumber,
    intent.commitId,
    intent.path,
    validateMarkerSet(intent.marker, intent.compatibleMarkers, "finding"),
    signal,
  );
}

/** Find one exact owned file comment across compatible markers. */
export async function findGitHubFileCommentByMarkers(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  commitId: string,
  path: string,
  markers: readonly string[],
  signal?: AbortSignal,
): Promise<GitHubFileCommentObservation | null> {
  validateSha(commitId);
  validatePath(path);
  validateMarkerList(markers, "finding");
  return listGitHubFileCommentByMarkers(
    token,
    repoFullName,
    pullRequestNumber,
    commitId,
    path,
    markers,
    signal,
  );
}

/** Observe one exact owned review comment without changing it. */
export async function observeGitHubReviewComment(
  token: string,
  repoFullName: string,
  intent: GitHubReviewCommentUpdateIntent,
  signal?: AbortSignal,
): Promise<GitHubFileCommentObservation> {
  validateReviewCommentUpdateIntent(intent);
  return getExactReviewComment(token, repoFullName, intent, signal);
}

/** Replace one owned review comment after observing its exact durable identity. */
export async function updateGitHubReviewComment(
  token: string,
  repoFullName: string,
  intent: GitHubReviewCommentUpdateIntent,
  signal?: AbortSignal,
): Promise<GitHubFileCommentObservation> {
  validateReviewCommentUpdateIntent(intent);
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
    const reviewMarkers = validateMarkerSet(
      intent.marker,
      intent.compatibleMarkers,
      "review",
    );
    const commentMarkerSets = validateUniqueFindingMarkerSets(intent.comments);
    const review = await findGitHubReviewByMarkers(
      token,
      repoFullName,
      pullRequestNumber,
      reviewMarkers,
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
      commentMarkerSets,
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
  review: GitHubReviewIdentityObservation,
  expectedCommentMarkers: readonly NormalizedMarkerSet[],
  signal?: AbortSignal,
): Promise<GitHubReviewObservation> {
  if (expectedCommentMarkers.length === 0) {
    return {
      ...review,
      commentIdsByMarker: {},
      missingCommentMarkers: [],
    };
  }
  const allMarkers = expectedCommentMarkers.flatMap((entry) => entry.markers);
  const comments = await listReviewComments(
    token,
    repoFullName,
    pullRequestNumber,
    review.reviewId,
    allMarkers,
    expectedCommentMarkers.length + 1,
    signal,
  );
  const commentIdsByMarker: Record<string, string> = {};
  const missingCommentMarkers: string[] = [];
  const claimedCommentIds = new Set<string>();
  for (const markerSet of expectedCommentMarkers) {
    const matches = comments.filter(
      (comment) =>
        typeof comment.body === "string" &&
        includesAnyMarker(comment.body, markerSet.markers) &&
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
      missingCommentMarkers.push(markerSet.marker);
      continue;
    }
    const remoteId = String(commentId);
    if (claimedCommentIds.has(remoteId)) {
      throw new GitHubPublicationAmbiguousError(
        "review comment marker identity",
      );
    }
    claimedCommentIds.add(remoteId);
    commentIdsByMarker[markerSet.marker] = remoteId;
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
  expectedMarkers: readonly string[],
  maximumMatches: number,
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
    for (const comment of value as ReviewCommentResponse[]) {
      if (
        typeof comment?.body === "string" &&
        includesAnyMarker(comment.body, expectedMarkers) &&
        isPostilBotLogin(comment.user?.login ?? undefined)
      ) {
        if (comments.length === maximumMatches) {
          throw new GitHubPublicationAmbiguousError(
            "review comment marker identity",
          );
        }
        comments.push(comment);
      }
    }
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
  try {
    const match = await findGitHubFileCommentByMarker(
      token,
      repoFullName,
      pullRequestNumber,
      intent,
      signal,
    );
    if (match !== null) return match;
  } catch (error) {
    if (error instanceof GitHubPublicationAmbiguousError) throw error;
    throw new GitHubPublicationAmbiguousError("file comment reconciliation", {
      cause: error,
    });
  }
  throw new GitHubPublicationAmbiguousError("file review comment", { cause });
}

async function listGitHubFileCommentByMarkers(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  commitId: string,
  expectedPath: string,
  markers: readonly string[],
  signal?: AbortSignal,
): Promise<GitHubFileCommentObservation | null> {
  const path = `${pullRequestPath(repoFullName, pullRequestNumber)}/comments`;
  let match: GitHubFileCommentObservation | undefined;
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
        comment.original_commit_id === commitId &&
        comment.path === expectedPath &&
        comment.subject_type === "file" &&
        typeof comment.body === "string" &&
        includesAnyMarker(comment.body, markers) &&
        isPostilBotLogin(comment.user?.login ?? undefined)
      ) {
        if (match !== undefined) {
          throw new GitHubPublicationAmbiguousError(
            "file comment marker identity",
          );
        }
        match = {
          commentId: String(comment.id),
          commitId: comment.original_commit_id,
          path: comment.path,
          body: comment.body,
        };
      }
    }
    if (!hasNextPage(response)) return match ?? null;
    if (page === MAX_PAGES) {
      throw new GitHubPublicationAmbiguousError("file comment marker search");
    }
  }
  throw new GitHubPublicationAmbiguousError("file comment pagination");
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

async function reconcileCheckRunCreation(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunStartIntent,
  githubApp: GitHubAppIdentity,
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<string> {
  try {
    const matches = await listExactCheckRuns(
      token,
      repoFullName,
      intent,
      githubApp,
      signal,
    );
    if (matches.length === 1) return String(matches[0]!.id);
  } catch (error) {
    if (error instanceof GitHubPublicationAmbiguousError) throw error;
    throw new GitHubPublicationAmbiguousError("check-run creation", {
      cause: error,
    });
  }
  throw new GitHubPublicationAmbiguousError("check-run creation", { cause });
}

async function listExactCheckRuns(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunStartIntent,
  githubApp: GitHubAppIdentity,
  signal?: AbortSignal,
): Promise<Array<CheckRunResponse & { id: number }>> {
  const matches: Array<CheckRunResponse & { id: number }> = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      check_name: intent.name,
      filter: "all",
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const response = await requestGitHub(
      token,
      "GET",
      `${repositoryPath(repoFullName)}/commits/${encodeURIComponent(intent.headSha)}/check-runs?${query}`,
      undefined,
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubPublicationRejectedError(
        "check-run creation reconciliation",
        response.status,
      );
    }
    const value = await readBoundedJson(response);
    const checkRuns = (value as { check_runs?: unknown })?.check_runs;
    if (!Array.isArray(checkRuns)) throw malformedResponse();
    for (const candidate of checkRuns) {
      const run = candidate as CheckRunResponse;
      if (matchesCheckRunIdentity(run, intent, githubApp)) {
        if (matches.length !== 0) {
          throw new GitHubPublicationAmbiguousError("check-run identity");
        }
        matches.push(run);
      }
    }
    if (!hasNextPage(response)) return matches;
    if (page === MAX_PAGES) {
      throw new GitHubPublicationAmbiguousError(
        "check-run creation reconciliation pagination",
      );
    }
  }
  throw new GitHubPublicationAmbiguousError(
    "check-run creation reconciliation pagination",
  );
}

async function observeExactCheckRunCompletion(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  githubApp: GitHubAppIdentity,
  signal?: AbortSignal,
): Promise<{
  run: CheckRunResponse & { id: number };
  annotations: NormalizedCheckRunAnnotation[];
}> {
  const run = await getExactCheckRun(
    token,
    repoFullName,
    intent,
    githubApp,
    signal,
  );
  const annotations = await getExactCheckRunAnnotations(
    token,
    repoFullName,
    intent,
    signal,
  );
  return { run, annotations };
}

function classifyCheckRunCompletion(
  run: CheckRunResponse,
  annotations: readonly NormalizedCheckRunAnnotation[],
  intent: GitHubCheckRunCompletionIntent,
): GitHubCheckRunCompletionObservation["desiredState"] {
  const desiredAnnotations = normalizeCheckRunAnnotations(
    intent.annotations ?? [],
  );
  if (
    isExactCompletedCheckRun(run, intent) &&
    checkRunAnnotationsEqual(annotations, desiredAnnotations)
  ) {
    return "applied";
  }
  if (
    run.status === "completed" ||
    !checkRunAnnotationsArePrefix(annotations, desiredAnnotations) ||
    (intent.detailsUrl === undefined && run.details_url != null)
  ) {
    return "conflict";
  }
  return "retryable";
}

async function appendGitHubCheckRunAnnotations(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  githubApp: GitHubAppIdentity,
  annotations: readonly GitHubCheckRunAnnotationIntent[],
  expectedPrefix: readonly NormalizedCheckRunAnnotation[],
  signal?: AbortSignal,
): Promise<void> {
  const path = `${repositoryPath(repoFullName)}/check-runs/${intent.checkRunId}`;
  const payload = buildCheckRunPatch(intent, annotations, false);
  let response: Response;
  try {
    response = await requestGitHub(
      token,
      "PATCH",
      path,
      payload,
      signal,
    );
  } catch (error) {
    return reconcileCheckRunAnnotationAppend(
      token,
      repoFullName,
      intent,
      githubApp,
      expectedPrefix,
      signal,
      error,
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 500) {
      throw new GitHubPublicationRejectedError(
        "check-run annotation append",
        response.status,
      );
    }
    return reconcileCheckRunAnnotationAppend(
      token,
      repoFullName,
      intent,
      githubApp,
      expectedPrefix,
      signal,
      new GitHubPublicationRejectedError(
        "check-run annotation append",
        response.status,
      ),
    );
  }

  try {
    const patched = parseExactCheckRun(
      await readBoundedJson(response),
      intent,
      githubApp,
    );
    if (!isExactInProgressCheckRun(patched, intent)) throw malformedResponse();
  } catch (error) {
    return reconcileCheckRunAnnotationAppend(
      token,
      repoFullName,
      intent,
      githubApp,
      expectedPrefix,
      signal,
      error,
    );
  }

  await verifyExactCheckRunAnnotationPrefix(
    token,
    repoFullName,
    intent,
    githubApp,
    expectedPrefix,
    signal,
  ).catch((error) => {
    throw new GitHubPublicationAmbiguousError(
      "check-run annotation append verification",
      { cause: error },
    );
  });
}

async function reconcileCheckRunAnnotationAppend(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  githubApp: GitHubAppIdentity,
  expectedPrefix: readonly NormalizedCheckRunAnnotation[],
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<void> {
  try {
    await verifyExactCheckRunAnnotationPrefix(
      token,
      repoFullName,
      intent,
      githubApp,
      expectedPrefix,
      signal,
    );
    return;
  } catch (error) {
    throw new GitHubPublicationAmbiguousError("check-run annotation append", {
      cause: error ?? cause,
    });
  }
}

async function verifyExactCheckRunAnnotationPrefix(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  githubApp: GitHubAppIdentity,
  expectedPrefix: readonly NormalizedCheckRunAnnotation[],
  signal?: AbortSignal,
): Promise<void> {
  const observed = await observeExactCheckRunCompletion(
    token,
    repoFullName,
    intent,
    githubApp,
    signal,
  );
  if (
    !isExactInProgressCheckRun(observed.run, intent) ||
    !checkRunAnnotationsEqual(observed.annotations, expectedPrefix)
  ) {
    throw new GitHubPublicationAmbiguousError(
      "check-run annotation append verification",
    );
  }
}

function largestCheckRunAnnotationChunk(
  intent: GitHubCheckRunCompletionIntent,
  remaining: readonly GitHubCheckRunAnnotationIntent[],
): readonly GitHubCheckRunAnnotationIntent[] {
  const maximumLength = Math.min(
    MAX_ANNOTATIONS_PER_REQUEST,
    remaining.length,
  );
  for (let length = maximumLength; length >= 1; length -= 1) {
    const chunk = remaining.slice(0, length);
    if (
      serializedJsonByteLength(buildCheckRunPatch(intent, chunk, false)) <=
      MAX_REQUEST_BYTES
    ) {
      return chunk;
    }
  }
  throw invalidIntent();
}

function buildCheckRunPatch(
  intent: GitHubCheckRunCompletionIntent,
  annotations: readonly GitHubCheckRunAnnotationIntent[],
  completed: boolean,
): Record<string, unknown> {
  return {
    status: completed ? "completed" : "in_progress",
    ...(completed ? { conclusion: intent.conclusion } : {}),
    output: {
      title: intent.title,
      summary: intent.summary,
      ...(annotations.length === 0
        ? {}
        : { annotations: annotations.map(githubCheckRunAnnotation) }),
    },
    ...(intent.detailsUrl === undefined
      ? {}
      : { details_url: intent.detailsUrl }),
  };
}

function githubCheckRunAnnotation(
  annotation: GitHubCheckRunAnnotationIntent,
): Record<string, unknown> {
  return {
    path: annotation.path,
    start_line: annotation.startLine,
    end_line: annotation.endLine,
    annotation_level: annotation.annotationLevel,
    message: annotation.message,
    ...(annotation.title === undefined ? {} : { title: annotation.title }),
    ...(annotation.rawDetails === undefined
      ? {}
      : { raw_details: annotation.rawDetails }),
    ...(annotation.startColumn === undefined
      ? {}
      : { start_column: annotation.startColumn }),
    ...(annotation.endColumn === undefined
      ? {}
      : { end_column: annotation.endColumn }),
  };
}

async function reconcileCheckRunCompletion(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  githubApp: GitHubAppIdentity,
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<void> {
  try {
    await verifyExactCompletedCheckRun(
      token,
      repoFullName,
      intent,
      githubApp,
      signal,
    );
    return;
  } catch (error) {
    throw new GitHubPublicationAmbiguousError("check-run completion", {
      cause: error,
    });
  }
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

async function getExactCheckRun(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  githubApp: GitHubAppIdentity,
  signal?: AbortSignal,
): Promise<CheckRunResponse & { id: number }> {
  const response = await requestGitHub(
    token,
    "GET",
    `${repositoryPath(repoFullName)}/check-runs/${intent.checkRunId}`,
    undefined,
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubPublicationRejectedError(
      "check-run observation",
      response.status,
    );
  }
  try {
    return parseExactCheckRun(await readBoundedJson(response), intent, githubApp);
  } catch (error) {
    throw new GitHubPublicationAmbiguousError("check-run identity", {
      cause: error,
    });
  }
}

async function getExactCheckRunAnnotations(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  signal?: AbortSignal,
): Promise<NormalizedCheckRunAnnotation[]> {
  const annotations: NormalizedCheckRunAnnotation[] = [];
  const maximumAnnotations = intent.annotations?.length ?? 0;
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await requestGitHub(
        token,
        "GET",
        `${repositoryPath(repoFullName)}/check-runs/${intent.checkRunId}/annotations?per_page=${PAGE_SIZE}&page=${page}`,
        undefined,
        signal,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GitHubPublicationRejectedError(
          "check-run annotation observation",
          response.status,
        );
      }
      const value = await readBoundedJson(response);
      if (!Array.isArray(value)) throw malformedResponse();
      for (const annotation of value) {
        annotations.push(normalizeRemoteCheckRunAnnotation(annotation));
        if (annotations.length > maximumAnnotations) {
          throw new GitHubPublicationAmbiguousError(
            "check-run annotation identity",
          );
        }
      }
      if (!hasNextPage(response)) return annotations;
      if (page === MAX_PAGES) {
        throw new GitHubPublicationAmbiguousError("check-run annotation pagination");
      }
    }
  } catch (error) {
    if (error instanceof GitHubPublicationAmbiguousError) throw error;
    throw new GitHubPublicationAmbiguousError("check-run annotation observation", {
      cause: error,
    });
  }
  throw new GitHubPublicationAmbiguousError("check-run annotation pagination");
}

async function verifyExactCompletedCheckRun(
  token: string,
  repoFullName: string,
  intent: GitHubCheckRunCompletionIntent,
  githubApp: GitHubAppIdentity,
  signal?: AbortSignal,
): Promise<void> {
  const run = await getExactCheckRun(
    token,
    repoFullName,
    intent,
    githubApp,
    signal,
  );
  const annotations = await getExactCheckRunAnnotations(
    token,
    repoFullName,
    intent,
    signal,
  );
  if (
    !isExactCompletedCheckRun(run, intent) ||
    !checkRunAnnotationsEqual(
      annotations,
      normalizeCheckRunAnnotations(intent.annotations ?? []),
    )
  ) {
    throw new GitHubPublicationAmbiguousError("check-run completion verification");
  }
}

async function getExactReview(
  token: string,
  repoFullName: string,
  pullRequestNumber: number,
  reviewId: string,
  commitId: string,
  markers: readonly string[],
  signal?: AbortSignal,
): Promise<GitHubReviewIdentityObservation> {
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
  return parseReview(await readBoundedJson(response), commitId, markers);
}

function parseReview(
  value: unknown,
  commitId: string,
  markers: readonly string[],
): GitHubReviewIdentityObservation {
  const review = value as ReviewResponse;
  if (
    !Number.isSafeInteger(review?.id) ||
    review.id! <= 0 ||
    review.commit_id !== commitId ||
    review.state !== "COMMENTED" ||
    typeof review.submitted_at !== "string" ||
    !Number.isFinite(Date.parse(review.submitted_at)) ||
    typeof review.body !== "string" ||
    !includesAnyMarker(review.body, markers) ||
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
  markers: readonly string[],
): GitHubFileCommentObservation {
  const comment = value as ReviewCommentResponse;
  if (
    !Number.isSafeInteger(comment?.id) ||
    comment.id! <= 0 ||
    comment.original_commit_id !== commitId ||
    comment.path !== path ||
    comment.subject_type !== "file" ||
    typeof comment.body !== "string" ||
    !includesAnyMarker(comment.body, markers) ||
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
    !includesAnyMarker(comment.body, intent.expectedMarkers) ||
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

function parseStartedCheckRun(
  value: unknown,
  intent: GitHubCheckRunStartIntent,
  githubApp: GitHubAppIdentity,
): string {
  const run = parseExactCheckRun(value, intent, githubApp);
  if (run.status !== "in_progress" || run.conclusion !== null) {
    throw malformedResponse();
  }
  return String(run.id);
}

function parseExactCheckRun(
  value: unknown,
  intent: GitHubCheckRunStartIntent & { checkRunId?: string },
  githubApp: GitHubAppIdentity,
): CheckRunResponse & { id: number } {
  const run = value as CheckRunResponse;
  if (!matchesCheckRunIdentity(run, intent, githubApp)) {
    throw malformedResponse();
  }
  if (
    intent.checkRunId !== undefined &&
    String(run.id) !== intent.checkRunId
  ) {
    throw malformedResponse();
  }
  return run as CheckRunResponse & { id: number };
}

function matchesCheckRunIdentity(
  run: CheckRunResponse,
  intent: GitHubCheckRunStartIntent,
  githubApp: GitHubAppIdentity,
): run is CheckRunResponse & { id: number } {
  return (
    Number.isSafeInteger(run?.id) &&
    run.id! > 0 &&
    run.name === intent.name &&
    run.external_id === intent.externalId &&
    run.head_sha === intent.headSha &&
    run.app?.id === githubApp.id
  );
}

function isExactCompletedCheckRun(
  run: CheckRunResponse,
  intent: GitHubCheckRunCompletionIntent,
): boolean {
  return (
    run.status === "completed" &&
    run.conclusion === intent.conclusion &&
    run.output?.title === intent.title &&
    run.output?.summary === intent.summary &&
    (intent.detailsUrl === undefined
      ? run.details_url === undefined || run.details_url === null
      : run.details_url === intent.detailsUrl)
  );
}

function isExactInProgressCheckRun(
  run: CheckRunResponse,
  intent: GitHubCheckRunCompletionIntent,
): boolean {
  return (
    run.status === "in_progress" &&
    run.conclusion === null &&
    run.output?.title === intent.title &&
    run.output?.summary === intent.summary &&
    (intent.detailsUrl === undefined
      ? run.details_url === undefined || run.details_url === null
      : run.details_url === intent.detailsUrl)
  );
}

function normalizeCheckRunAnnotations(
  annotations: readonly GitHubCheckRunAnnotationIntent[],
): NormalizedCheckRunAnnotation[] {
  return annotations.map((annotation) => ({
    path: annotation.path,
    startLine: annotation.startLine,
    endLine: annotation.endLine,
    annotationLevel: annotation.annotationLevel,
    message: annotation.message,
    title: annotation.title ?? null,
    rawDetails: annotation.rawDetails ?? null,
    startColumn: annotation.startColumn ?? null,
    endColumn: annotation.endColumn ?? null,
  }));
}

function normalizeRemoteCheckRunAnnotation(
  value: unknown,
): NormalizedCheckRunAnnotation {
  const annotation = value as CheckRunAnnotationResponse;
  if (
    typeof annotation?.path !== "string" ||
    !Number.isSafeInteger(annotation.start_line) ||
    annotation.start_line! <= 0 ||
    !Number.isSafeInteger(annotation.end_line) ||
    annotation.end_line! < annotation.start_line! ||
    (annotation.annotation_level !== "notice" &&
      annotation.annotation_level !== "warning" &&
      annotation.annotation_level !== "failure") ||
    typeof annotation.message !== "string"
  ) {
    throw malformedResponse();
  }
  const title = normalizeNullableAnnotationString(annotation.title);
  const rawDetails = normalizeNullableAnnotationString(annotation.raw_details);
  const startColumn = normalizeNullableAnnotationColumn(annotation.start_column);
  const endColumn = normalizeNullableAnnotationColumn(annotation.end_column);
  if (
    (startColumn === null) !== (endColumn === null) ||
    (startColumn !== null &&
      (annotation.start_line !== annotation.end_line ||
        endColumn === null ||
        endColumn < startColumn))
  ) {
    throw malformedResponse();
  }
  return {
    path: annotation.path,
    startLine: annotation.start_line!,
    endLine: annotation.end_line!,
    annotationLevel: annotation.annotation_level,
    message: annotation.message,
    title,
    rawDetails,
    startColumn,
    endColumn,
  };
}

function normalizeNullableAnnotationString(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw malformedResponse();
  return value;
}

function normalizeNullableAnnotationColumn(
  value: number | null | undefined,
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw malformedResponse();
  return value;
}

function checkRunAnnotationsEqual(
  left: readonly NormalizedCheckRunAnnotation[],
  right: readonly NormalizedCheckRunAnnotation[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (annotation, index) =>
        annotation.path === right[index]?.path &&
        annotation.startLine === right[index]?.startLine &&
        annotation.endLine === right[index]?.endLine &&
        annotation.annotationLevel === right[index]?.annotationLevel &&
        annotation.message === right[index]?.message &&
        annotation.title === right[index]?.title &&
        annotation.rawDetails === right[index]?.rawDetails &&
        annotation.startColumn === right[index]?.startColumn &&
        annotation.endColumn === right[index]?.endColumn,
    )
  );
}

function checkRunAnnotationsArePrefix(
  prefix: readonly NormalizedCheckRunAnnotation[],
  complete: readonly NormalizedCheckRunAnnotation[],
): boolean {
  return (
    prefix.length <= complete.length &&
    checkRunAnnotationsEqual(prefix, complete.slice(0, prefix.length))
  );
}

async function requestGitHub(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const serializedBody = body === undefined
    ? undefined
    : serializeBoundedRequestBody(body);
  return fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "postil-control-plane",
      "Content-Type": "application/json",
    },
    body: serializedBody,
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
  const markers = validateMarkerSet(
    comment.marker,
    comment.compatibleMarkers,
    "finding",
  );
  requireAnyMarker(comment.body, markers);
  if (comment.side !== "LEFT" && comment.side !== "RIGHT") {
    throw invalidIntent();
  }
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
  if (
    comment.startSide !== undefined &&
    comment.startSide !== "LEFT" &&
    comment.startSide !== "RIGHT"
  ) {
    throw invalidIntent();
  }
}

function configuredGithubAppIdentity(
  intent: GitHubCheckRunStartIntent,
): GitHubAppIdentity {
  const idSource = process.env.GITHUB_APP_ID;
  if (
    idSource === undefined ||
    !/^[1-9][0-9]{0,15}$/.test(idSource)
  ) {
    throw new Error("GitHub App configuration is invalid");
  }
  const id = Number(idSource);
  if (!Number.isSafeInteger(id) || intent.appId !== id) {
    throw new Error("GitHub App configuration is invalid");
  }
  return { id };
}

function validateCheckRunStartIntent(intent: GitHubCheckRunStartIntent): void {
  if (intent.name !== "postil/review" && intent.name !== "postil/gate") {
    throw invalidIntent();
  }
  validateSha(intent.headSha);
  if (
    typeof intent.externalId !== "string" ||
    intent.externalId.length === 0 ||
    Buffer.byteLength(intent.externalId) > 500 ||
    intent.externalId.includes("\0")
  ) {
    throw invalidIntent();
  }
  if (intent.detailsUrl !== undefined) validateDetailsUrl(intent.detailsUrl);
}

function validateCheckRunCompletionIntent(
  intent: GitHubCheckRunCompletionIntent,
): void {
  validateCheckRunStartIntent(intent);
  validateRemoteId(intent.checkRunId);
  if (
    intent.conclusion !== "success" &&
    intent.conclusion !== "failure" &&
    intent.conclusion !== "neutral"
  ) {
    throw invalidIntent();
  }
  validateCheckRunOutput(intent.title, 255);
  validateCheckRunOutput(intent.summary, MAX_CHECK_SUMMARY_BYTES);
  const annotations = intent.annotations ?? [];
  if (!Array.isArray(annotations) || annotations.length > MAX_FINDINGS) {
    throw invalidIntent();
  }
  for (const annotation of annotations) validateCheckRunAnnotation(annotation);
  validateAggregateTextBytes([
    intent.title,
    intent.summary,
    ...annotations.flatMap((annotation) => [
      annotation.title ?? "",
      annotation.message,
      annotation.rawDetails ?? "",
    ]),
  ]);
}

function validateCheckRunAnnotation(
  annotation: GitHubCheckRunAnnotationIntent,
): void {
  validatePath(annotation.path);
  if (
    !Number.isSafeInteger(annotation.startLine) ||
    annotation.startLine <= 0 ||
    !Number.isSafeInteger(annotation.endLine) ||
    annotation.endLine < annotation.startLine ||
    (annotation.annotationLevel !== "notice" &&
      annotation.annotationLevel !== "warning" &&
      annotation.annotationLevel !== "failure")
  ) {
    throw invalidIntent();
  }
  validateCheckRunOutput(annotation.message, 65_535);
  if (annotation.title !== undefined) validateCheckRunOutput(annotation.title, 255);
  if (annotation.rawDetails !== undefined) {
    validateCheckRunOutput(annotation.rawDetails, 65_535);
  }
  if (
    (annotation.startColumn === undefined) !==
    (annotation.endColumn === undefined)
  ) {
    throw invalidIntent();
  }
  if (annotation.startColumn === undefined || annotation.endColumn === undefined) {
    return;
  }
  if (
    annotation.startLine !== annotation.endLine ||
    !Number.isSafeInteger(annotation.startColumn) ||
    annotation.startColumn <= 0 ||
    !Number.isSafeInteger(annotation.endColumn) ||
    annotation.endColumn < annotation.startColumn
  ) {
    throw invalidIntent();
  }
}

function validateCheckRunOutput(value: string, maximumBytes: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maximumBytes ||
    value.includes("\0")
  ) {
    throw invalidIntent();
  }
}

function validateDetailsUrl(value: string): void {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_DETAILS_URL_BYTES
  ) {
    throw invalidIntent();
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      throw invalidIntent();
    }
  } catch {
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
  if (!isValidGitHubRepositoryFullName(repoFullName)) throw invalidIntent();
  const [owner, repo] = repoFullName.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function validateMarker(marker: string, kind: "review" | "finding"): void {
  const pattern = new RegExp(
    `^<!-- postil-${kind}:(?:v1:[0-9a-f]{12}|v2:[0-9a-f]{64}) -->$`,
  );
  if (!pattern.test(marker)) throw invalidIntent();
}

function validateMarkerSet(
  marker: string,
  compatibleMarkers: readonly string[] | undefined,
  kind: "review" | "finding",
): readonly string[] {
  if (compatibleMarkers !== undefined && !Array.isArray(compatibleMarkers)) {
    throw invalidIntent();
  }
  const markers = [marker, ...(compatibleMarkers ?? [])];
  validateMarkerList(markers, kind);
  return markers;
}

function validateMarkerList(
  markers: readonly string[],
  kind: "review" | "finding",
): void {
  if (
    !Array.isArray(markers) ||
    markers.length === 0 ||
    markers.length > MAX_MARKERS ||
    new Set(markers).size !== markers.length
  ) {
    throw invalidIntent();
  }
  for (const marker of markers) validateMarker(marker, kind);
}

function validateUniqueFindingMarkerSets(
  comments: readonly GitHubReviewCommentIntent[],
): readonly NormalizedMarkerSet[] {
  return validateExpectedCommentMarkerSets(comments);
}

function validateExpectedCommentMarkerSets(
  inputs: readonly (string | GitHubFindingMarkerSet)[],
): readonly NormalizedMarkerSet[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_FINDINGS) {
    throw invalidIntent();
  }
  const claimedMarkers = new Set<string>();
  return inputs.map((input) => {
    const markerSet = typeof input === "string"
      ? { marker: input, compatibleMarkers: undefined }
      : input;
    if (
      markerSet === null ||
      typeof markerSet !== "object" ||
      Array.isArray(markerSet)
    ) {
      throw invalidIntent();
    }
    const markers = validateMarkerSet(
      markerSet.marker,
      markerSet.compatibleMarkers,
      "finding",
    );
    for (const marker of markers) {
      if (claimedMarkers.has(marker)) throw invalidIntent();
      claimedMarkers.add(marker);
    }
    return { marker: markerSet.marker, markers };
  });
}

function validateReviewCommentUpdateIntent(
  intent: GitHubReviewCommentUpdateIntent,
): void {
  validateRemoteId(intent.commentId);
  validateSha(intent.commitId);
  validatePath(intent.path);
  validateMarkerList(intent.expectedMarkers, "finding");
  requireAnyMarker(intent.body, intent.expectedMarkers);
  validateAggregateTextBytes([intent.body]);
}

function requireAnyMarker(body: string, markers: readonly string[]): void {
  if (
    typeof body !== "string" ||
    body.length === 0 ||
    Buffer.byteLength(body) > MAX_TEXT_BYTES ||
    !includesAnyMarker(body, markers)
  ) {
    throw invalidIntent();
  }
}

function includesAnyMarker(body: string, markers: readonly string[]): boolean {
  return markers.some((marker) => body.includes(marker));
}

function validateAggregateTextBytes(values: readonly string[]): void {
  let bytes = 0;
  for (const value of values) {
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > MAX_AGGREGATE_TEXT_BYTES) throw invalidIntent();
  }
}

function serializeJson(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidIntent();
  }
  if (typeof serialized !== "string") throw invalidIntent();
  return serialized;
}

function serializedJsonByteLength(value: unknown): number {
  return Buffer.byteLength(serializeJson(value), "utf8");
}

function requireSerializedRequestWithinLimit(value: unknown): void {
  if (serializedJsonByteLength(value) > MAX_REQUEST_BYTES) {
    throw invalidIntent();
  }
}

function serializeBoundedRequestBody(value: unknown): string {
  const serialized = serializeJson(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw invalidIntent();
  }
  return serialized;
}

function validatePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path) > MAX_PATH_BYTES ||
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
