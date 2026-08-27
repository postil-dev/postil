import { apiBase } from "@/lib/github/app-auth";
import type { PublicationThreadObservation } from "@/lib/publication-receipt";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

interface ThreadNode {
  id?: string | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  viewerCanResolve?: boolean;
  comments?: CommentsConnection | null;
}

interface CommentsConnection {
  nodes?: Array<{ databaseId?: number | null } | null> | null;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

interface ThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<ThreadNode | null> | null;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
        } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

interface ThreadCommentsResponse {
  data?: {
    node?: {
      comments?: CommentsConnection | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

interface ResolveThreadResponse {
  data?: {
    resolveReviewThread?: {
      thread?: { id?: string | null; isResolved?: boolean } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

function graphqlApi(): string {
  const rest = apiBase().replace(/\/+$/, "");
  return rest.endsWith("/api/v3")
    ? `${rest.slice(0, -"/api/v3".length)}/api/graphql`
    : `${rest}/graphql`;
}

/**
 * Read the forge's thread flags. Comment prose, reactions, and review
 * dismissal never participate in lifecycle reconciliation.
 */
export async function observeGitHubReviewThreads(
  token: string,
  repoFullName: string,
  prNumber: number,
  expectedCommentIds: string[],
  signal?: AbortSignal,
): Promise<PublicationThreadObservation[]> {
  if (expectedCommentIds.length === 0) return [];
  const [owner, name, extra] = repoFullName.split("/");
  if (!owner || !name || extra || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("invalid GitHub pull request identity for publication observation");
  }
  const expected = new Set(expectedCommentIds);
  const observed = new Map<
    string,
    Pick<
      PublicationThreadObservation,
      "githubThreadId" | "state" | "viewerCanResolve"
    >
  >();
  const timeoutSignal = AbortSignal.timeout(15_000);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  async function requestGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(graphqlApi(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "postil-control-plane",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`GitHub review thread observation failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
  function recordComments(
    comments: CommentsConnection | null | undefined,
    githubThreadId: string,
    state: PublicationThreadObservation["state"],
    viewerCanResolve: boolean,
  ): void {
    for (const comment of comments?.nodes ?? []) {
      const id = comment?.databaseId;
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
        const key = String(id);
        if (expected.has(key)) {
          observed.set(key, { githubThreadId, state, viewerCanResolve });
        }
      }
    }
  }
  async function observeRemainingComments(
    threadId: string,
    initialCursor: string,
    state: PublicationThreadObservation["state"],
    viewerCanResolve: boolean,
  ): Promise<void> {
    let commentsCursor: string | null = initialCursor;
    for (let page = 1; page < MAX_PAGES; page += 1) {
      const payload: ThreadCommentsResponse = await requestGraphql<ThreadCommentsResponse>(
        `query PostilPublicationThreadComments($threadId: ID!, $commentsCursor: String) {
          node(id: $threadId) {
            ... on PullRequestReviewThread {
              comments(first: ${PAGE_SIZE}, after: $commentsCursor) {
                nodes { databaseId }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { threadId, commentsCursor },
      );
      if (payload.errors?.length) {
        throw new Error("GitHub review thread comment observation returned GraphQL errors");
      }
      const comments: CommentsConnection | null | undefined = payload.data?.node?.comments;
      if (!comments) {
        throw new Error("GitHub review thread comment observation returned no thread");
      }
      recordComments(comments, threadId, state, viewerCanResolve);
      if (!comments.pageInfo?.hasNextPage) return;
      commentsCursor = comments.pageInfo.endCursor ?? null;
      if (!commentsCursor) {
        throw new Error("GitHub review thread comment pagination omitted its cursor");
      }
    }
    throw new Error(`GitHub review thread comment observation exceeded ${MAX_PAGES} pages`);
  }
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload: ThreadsResponse = await requestGraphql<ThreadsResponse>(
      `query PostilPublicationThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
                nodes {
                  id
                  isResolved
                  isOutdated
                  viewerCanResolve
                  comments(first: ${PAGE_SIZE}) {
                    nodes { databaseId }
                    pageInfo { hasNextPage endCursor }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
      { owner, name, number: prNumber, cursor },
    );
    if (payload.errors?.length) {
      throw new Error("GitHub review thread observation returned GraphQL errors");
    }
    const threads: NonNullable<
      NonNullable<NonNullable<ThreadsResponse["data"]>["repository"]>["pullRequest"]
    >["reviewThreads"] = payload.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error("GitHub review thread observation returned no pull request");
    for (const thread of threads.nodes ?? []) {
      if (!thread) continue;
      if (!thread.id) {
        throw new Error("GitHub review thread observation omitted its identity");
      }
      if (typeof thread.viewerCanResolve !== "boolean") {
        throw new Error("GitHub review thread observation omitted its resolution capability");
      }
      const state = thread.isResolved
        ? "resolved"
        : thread.isOutdated
          ? "outdated"
          : "inline";
      recordComments(
        thread.comments,
        thread.id,
        state,
        thread.viewerCanResolve,
      );
      if (thread.comments?.pageInfo?.hasNextPage) {
        const commentsCursor = thread.comments.pageInfo.endCursor ?? null;
        if (!commentsCursor) {
          throw new Error("GitHub review thread comment pagination omitted its identity or cursor");
        }
        await observeRemainingComments(
          thread.id,
          commentsCursor,
          state,
          thread.viewerCanResolve,
        );
      }
    }
    if (!threads.pageInfo?.hasNextPage) {
      return expectedCommentIds.map((githubCommentId) => {
        const thread = observed.get(githubCommentId);
        return thread
          ? { githubCommentId, ...thread }
          : { githubCommentId, state: "deleted" };
      });
    }
    cursor = threads.pageInfo.endCursor ?? null;
    if (!cursor) throw new Error("GitHub review thread pagination omitted its cursor");
  }
  throw new Error(`GitHub review thread observation exceeded ${MAX_PAGES} pages`);
}

/** Resolve only Postil-owned threads whose durable finding state is terminal. */
export async function resolveGitHubReviewThreads(
  token: string,
  observations: PublicationThreadObservation[],
  resolveCommentIds: string[],
  signal?: AbortSignal,
): Promise<PublicationThreadObservation[]> {
  if (resolveCommentIds.length === 0) return observations;
  const expected = new Set(resolveCommentIds);
  const threadIds = new Set<string>();
  for (const observation of observations) {
    if (
      expected.has(observation.githubCommentId) &&
      observation.state !== "resolved" &&
      observation.state !== "deleted"
    ) {
      if (!observation.githubThreadId) {
        throw new Error("GitHub review thread resolution omitted its thread identity");
      }
      if (
        observation.viewerCanResolve === false &&
        observation.state === "outdated"
      ) {
        continue;
      }
      if (observation.viewerCanResolve !== true) {
        throw new Error(
          observation.viewerCanResolve === false
            ? "GitHub cannot resolve an active Postil review thread"
            : "GitHub review thread resolution capability is unknown",
        );
      }
      threadIds.add(observation.githubThreadId);
    }
  }
  if (threadIds.size === 0) return observations;
  const timeoutSignal = AbortSignal.timeout(15_000);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const resolved = new Set<string>();
  for (const threadId of threadIds) {
    const response = await fetch(graphqlApi(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "postil-control-plane",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation PostilResolvePublicationThread($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        variables: { threadId },
      }),
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`GitHub review thread resolution failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as ResolveThreadResponse;
    if (payload.errors?.length) {
      throw new Error("GitHub review thread resolution returned GraphQL errors");
    }
    const thread = payload.data?.resolveReviewThread?.thread;
    if (thread?.id !== threadId || thread.isResolved !== true) {
      throw new Error("GitHub did not confirm review thread resolution");
    }
    resolved.add(threadId);
  }
  return observations.map((observation) =>
    observation.githubThreadId && resolved.has(observation.githubThreadId)
      ? { ...observation, state: "resolved" }
      : observation,
  );
}
