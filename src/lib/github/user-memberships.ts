export interface GithubOrgMembership {
  role?: string;
  state?: string;
  organization?: { id?: number; login?: string };
}

export type GithubMembershipFetchResult =
  | { ok: true; memberships: GithubOrgMembership[] }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "unavailable"; retryAfterMs: number };

const MEMBERSHIPS_URL =
  "https://api.github.com/user/memberships/orgs?per_page=100&state=active";
const MAX_MEMBERSHIP_PAGES = 100;
const MEMBERSHIP_REQUEST_TIMEOUT_MS = 10_000;
const MEMBERSHIP_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const RATE_LIMIT_RETRY_AFTER_MS = 60_000;
const MIN_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** Fetch the authenticated user's complete active organization membership set. */
export async function fetchAllActiveOrgMemberships(
  accessToken: string,
): Promise<GithubMembershipFetchResult> {
  const memberships: GithubOrgMembership[] = [];
  const totalSignal = AbortSignal.timeout(MEMBERSHIP_TOTAL_TIMEOUT_MS);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "postil-control-plane",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let next: string | null = MEMBERSHIPS_URL;

  for (let page = 0; next && page < MAX_MEMBERSHIP_PAGES; page++) {
    let response: Response;
    try {
      response = await fetch(next, {
        headers,
        signal: AbortSignal.any([
          totalSignal,
          AbortSignal.timeout(MEMBERSHIP_REQUEST_TIMEOUT_MS),
        ]),
      });
    } catch {
      return unavailable();
    }

    if (response.status === 401) return { ok: false, reason: "unauthorized" };
    if (!response.ok) return unavailable(response);

    let batch: unknown;
    try {
      batch = await response.json();
    } catch {
      return unavailable();
    }
    if (!Array.isArray(batch)) return unavailable();

    memberships.push(...(batch as GithubOrgMembership[]));
    const nextPage = nextPageUrl(response.headers.get("link"));
    if (nextPage === undefined) return unavailable();
    next = nextPage;
  }

  return next === null
    ? { ok: true, memberships }
    : unavailable();
}

function unavailable(response?: Response): GithubMembershipFetchResult {
  const now = Date.now();
  const retryAfter = response?.headers.get("retry-after");
  let retryAfterMs: number | undefined;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      retryAfterMs = seconds * 1000;
    } else {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) retryAfterMs = retryAt - now;
    }
  }
  if (retryAfterMs === undefined && response?.headers.get("x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds)) retryAfterMs = resetSeconds * 1000 - now;
  }
  if (retryAfterMs === undefined) {
    retryAfterMs =
      response?.status === 403 || response?.status === 429
        ? RATE_LIMIT_RETRY_AFTER_MS
        : DEFAULT_RETRY_AFTER_MS;
  }
  return {
    ok: false,
    reason: "unavailable",
    retryAfterMs: Math.min(
      Math.max(Math.ceil(retryAfterMs), MIN_RETRY_AFTER_MS),
      MAX_RETRY_AFTER_MS,
    ),
  };
}

/** Extract the rel="next" URL from a GitHub Link header. */
export function nextPageUrl(link: string | null): string | null | undefined {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (!match) continue;
    try {
      const url = new URL(match[1]!);
      if (url.origin === "https://api.github.com") return url.href;
    } catch {
      return undefined;
    }
    return undefined;
  }
  return null;
}
