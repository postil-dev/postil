import { apiBase } from "@/lib/github/app-auth";
import type { PublicationThreadObservation } from "@/lib/publication-receipt";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

interface ThreadNode {
  id?: string | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  resolvedBy?: { databaseId?: number | null; login?: string | null } | null;
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

interface RepositoryPermissionResponse {
  permission?: string;
  user?: { id?: number; login?: string };
}

interface GithubActorIdentity {
  id?: number;
  login?: string;
}

function graphqlApi(): string {
  const rest = apiBase().replace(/\/+$/, "");
  return rest.endsWith("/api/v3")
    ? `${rest.slice(0, -"/api/v3".length)}/api/graphql`
    : `${rest}/graphql`;
}

function validActorIdentity(
  actor: GithubActorIdentity | null | undefined,
): actor is { id: number; login: string } {
  return typeof actor?.id === "number" &&
    Number.isSafeInteger(actor.id) &&
    actor.id > 0 &&
    typeof actor.login === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(actor.login);
}

async function fetchRepositoryWriteAuthority(
  token: string,
  repositoryOwner: string,
  repositoryName: string,
  actor: { id: number; login: string },
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetch(
    `${apiBase().replace(/\/+$/, "")}/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/collaborators/${encodeURIComponent(actor.login)}/permission`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "postil-control-plane",
      },
      signal,
    },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`GitHub actor authority failed with HTTP ${response.status}`);
  }
  let permission: RepositoryPermissionResponse;
  try {
    permission = (await response.json()) as RepositoryPermissionResponse;
  } catch {
    throw new Error("GitHub actor authority returned malformed JSON");
  }
  if (
    permission.user?.id !== actor.id ||
    permission.user.login?.toLowerCase() !== actor.login.toLowerCase() ||
    !["admin", "write", "read", "none"].includes(permission.permission ?? "")
  ) {
    throw new Error("GitHub actor authority returned an inconsistent identity");
  }
  return permission.permission === "admin" || permission.permission === "write";
}

/** Re-read one exact GitHub identity's current repository authority. */
export async function hasGitHubRepositoryWriteAuthority(
  token: string,
  repoFullName: string,
  actor: GithubActorIdentity | null | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  const [owner, name, extra] = repoFullName.split("/");
  if (!owner || !name || extra || !validActorIdentity(actor)) return false;
  const timeoutSignal = AbortSignal.timeout(10_000);
  return fetchRepositoryWriteAuthority(
    token,
    owner,
    name,
    actor,
    signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  );
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
  authorGithubId: number,
  signal?: AbortSignal,
): Promise<PublicationThreadObservation[]> {
  if (expectedCommentIds.length === 0) return [];
  if (!Number.isSafeInteger(authorGithubId) || authorGithubId <= 0) {
    throw new Error("GitHub pull request observation omitted its author identity");
  }
  const [owner, name, extra] = repoFullName.split("/");
  if (!owner || !name || extra || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("invalid GitHub pull request identity for publication observation");
  }
  const repositoryOwner = owner;
  const repositoryName = name;
  const expected = new Set(expectedCommentIds);
  const observed = new Map<string, Omit<PublicationThreadObservation, "githubCommentId">>();
  const maintainerAuthority = new Map<string, boolean>();
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
  function collectExpectedComments(
    comments: CommentsConnection | null | undefined,
    matched: Set<string>,
  ): void {
    for (const comment of comments?.nodes ?? []) {
      const id = comment?.databaseId;
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
        const key = String(id);
        if (expected.has(key)) matched.add(key);
      }
    }
  }
  async function resolverHasMaintainerAuthority(
    resolver: ThreadNode["resolvedBy"],
  ): Promise<boolean> {
    const actor = {
      id: resolver?.databaseId ?? undefined,
      login: resolver?.login ?? undefined,
    };
    if (!validActorIdentity(actor)) return false;
    const cacheKey = `${actor.id}:${actor.login.toLowerCase()}`;
    const cached = maintainerAuthority.get(cacheKey);
    if (cached !== undefined) return cached;
    const authorized = await fetchRepositoryWriteAuthority(
      token,
      repositoryOwner,
      repositoryName,
      actor,
      requestSignal,
    );
    maintainerAuthority.set(cacheKey, authorized);
    return authorized;
  }
  async function observeRemainingComments(
    threadId: string,
    initialCursor: string,
    matched: Set<string>,
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
      collectExpectedComments(comments, matched);
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
                  resolvedBy { databaseId login }
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
      const matched = new Set<string>();
      collectExpectedComments(thread.comments, matched);
      if (thread.comments?.pageInfo?.hasNextPage) {
        const threadId = thread.id;
        const commentsCursor = thread.comments.pageInfo.endCursor ?? null;
        if (!threadId || !commentsCursor) {
          throw new Error("GitHub review thread comment pagination omitted its identity or cursor");
        }
        await observeRemainingComments(threadId, commentsCursor, matched);
      }
      if (matched.size > 0) {
        const resolver = {
          id: thread.resolvedBy?.databaseId ?? undefined,
          login: thread.resolvedBy?.login ?? undefined,
        };
        const resolverIdentity = validActorIdentity(resolver)
          ? {
              resolvedByGithubId: resolver.id,
              resolvedByLogin: resolver.login,
            }
          : {};
        const resolvedByAuthor = resolver.id === authorGithubId;
        const observation: Omit<PublicationThreadObservation, "githubCommentId"> =
          thread.isOutdated
            ? { state: "outdated" }
            : thread.isResolved
              ? !resolvedByAuthor && await resolverHasMaintainerAuthority(thread.resolvedBy)
                ? {
                    state: "resolved",
                    resolutionAuthorized: true,
                    ...resolverIdentity,
                  }
                : {
                    state: "resolved",
                    resolutionAuthorized: false,
                    ...resolverIdentity,
                  }
              : { state: "inline" };
        for (const commentId of matched) observed.set(commentId, observation);
      }
    }
    if (!threads.pageInfo?.hasNextPage) {
      return expectedCommentIds.map((githubCommentId) => ({
        githubCommentId,
        ...(observed.get(githubCommentId) ?? { state: "deleted" as const }),
      }));
    }
    cursor = threads.pageInfo.endCursor ?? null;
    if (!cursor) throw new Error("GitHub review thread pagination omitted its cursor");
  }
  throw new Error(`GitHub review thread observation exceeded ${MAX_PAGES} pages`);
}
