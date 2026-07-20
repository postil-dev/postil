export class GithubRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAt: Date,
  ) {
    super(message);
    this.name = "GithubRateLimitError";
  }
}

const SECONDARY_RATE_LIMIT_PATTERN = /secondary rate limit|abuse detection/i;

/** Convert a failed GitHub REST response into a bounded, non-secret error. */
export async function githubResponseError(
  operation: string,
  response: Response,
  now = Date.now(),
): Promise<Error> {
  const body = await response.text().catch(() => "");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const reset = Number(resetHeader);
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = Number(retryAfterHeader);
  const rateLimitedStatus = response.status === 403 || response.status === 429;

  if (
    rateLimitedStatus &&
    retryAfterHeader !== null &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
  ) {
    return rateLimitError(operation, new Date(now + retryAfter * 1000 + 1_000));
  }
  if (rateLimitedStatus && remaining === "0") {
    const retryAt = resetHeader !== null && Number.isFinite(reset)
      ? new Date(reset * 1000 + 1_000)
      : new Date(now + 60_000);
    return rateLimitError(operation, retryAt);
  }
  if (
    response.status === 429 ||
    (response.status === 403 && SECONDARY_RATE_LIMIT_PATTERN.test(body))
  ) {
    return rateLimitError(operation, new Date(now + 60_000));
  }
  return new Error(`GitHub ${operation} failed with HTTP ${response.status}`);
}

function rateLimitError(operation: string, retryAt: Date): GithubRateLimitError {
  return new GithubRateLimitError(
    `GitHub ${operation} rate limited until ${retryAt.toISOString()}`,
    retryAt,
  );
}
