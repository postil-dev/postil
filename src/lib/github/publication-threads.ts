import { apiBase } from "@/lib/github/app-auth";
import type { PublicationThreadObservation } from "@/lib/publication-receipt";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

interface ThreadNode {
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: { nodes?: Array<{ databaseId?: number | null } | null> | null } | null;
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
  const observed = new Map<string, PublicationThreadObservation["state"]>();
  const timeoutSignal = AbortSignal.timeout(15_000);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
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
        query: `query PostilPublicationThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
                nodes {
                  isResolved
                  isOutdated
                  comments(first: ${PAGE_SIZE}) { nodes { databaseId } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        variables: { owner, name, number: prNumber, cursor },
      }),
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`GitHub review thread observation failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as ThreadsResponse;
    if (payload.errors?.length) {
      throw new Error("GitHub review thread observation returned GraphQL errors");
    }
    const threads = payload.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error("GitHub review thread observation returned no pull request");
    for (const thread of threads.nodes ?? []) {
      if (!thread) continue;
      const state = thread.isResolved
        ? "resolved"
        : thread.isOutdated
          ? "outdated"
          : "inline";
      for (const comment of thread.comments?.nodes ?? []) {
        const id = comment?.databaseId;
        if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
          const key = String(id);
          if (expected.has(key)) observed.set(key, state);
        }
      }
    }
    if (!threads.pageInfo?.hasNextPage) {
      return expectedCommentIds.map((githubCommentId) => ({
        githubCommentId,
        state: observed.get(githubCommentId) ?? "deleted",
      }));
    }
    cursor = threads.pageInfo.endCursor ?? null;
    if (!cursor) throw new Error("GitHub review thread pagination omitted its cursor");
  }
  throw new Error(`GitHub review thread observation exceeded ${MAX_PAGES} pages`);
}
