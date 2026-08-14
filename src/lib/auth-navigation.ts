export const PROTECTED_RETURN_TO_HEADER = "x-postil-protected-return-to";
export const MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST =
  "postil-membership-verification-unavailable";
export const MEMBERSHIP_RETRY_FALLBACK_MS = 5_000;
export const MEMBERSHIP_RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
const MEMBERSHIP_RETRY_MIN_DELAY_MS = 1_000;

type RetryAfterHeaders = Pick<Headers, "get">;

/** Serialize a membership retry timestamp as a bounded HTTP delta-seconds value. */
export function membershipRetryAfterHeader(
  retryAvailableAt: Date | number | undefined,
  now = Date.now(),
): string {
  const bounded = boundedMembershipRetryAvailableAt(retryAvailableAt, now);
  return String(Math.ceil((bounded.getTime() - now) / 1_000));
}

/** Parse Retry-After without allowing malformed or remote values to create request storms. */
export function boundedRetryAfterDelayMs(
  headers: RetryAfterHeaders,
  fallbackMs: number,
  now = Date.now(),
): number {
  const header = headers.get("retry-after")?.trim();
  let requestedMs: number | undefined;
  if (header && /^\d+$/.test(header)) {
    requestedMs = Number(header) * 1_000;
  } else if (header) {
    const retryAt = Date.parse(header);
    if (Number.isFinite(retryAt)) requestedMs = retryAt - now;
  }
  return boundedRetryDelayMs(requestedMs, fallbackMs);
}

/** Bound a provider or fallback delay to the shared membership retry window. */
export function boundedRetryDelayMs(
  requestedMs: number | undefined,
  fallbackMs = MEMBERSHIP_RETRY_FALLBACK_MS,
): number {
  const finiteFallback = Number.isFinite(fallbackMs)
    ? fallbackMs
    : MEMBERSHIP_RETRY_FALLBACK_MS;
  return Math.min(
    Math.max(
      Math.ceil(requestedMs ?? finiteFallback),
      MEMBERSHIP_RETRY_MIN_DELAY_MS,
    ),
    MEMBERSHIP_RETRY_MAX_DELAY_MS,
  );
}

/** Schedule a bounded retry through an injected timer so polling behavior is testable. */
export function scheduleRetryAfter<T>(
  headers: RetryAfterHeaders,
  callback: () => void,
  fallbackMs: number,
  schedule: (callback: () => void, delayMs: number) => T,
  now = Date.now(),
): T {
  return schedule(
    callback,
    boundedRetryAfterDelayMs(headers, fallbackMs, now),
  );
}

/** Bound retry metadata before it crosses the server-to-client error boundary. */
export function boundedMembershipRetryAvailableAt(
  retryAvailableAt: Date | number | undefined,
  now = Date.now(),
): Date {
  const requested =
    retryAvailableAt instanceof Date
      ? retryAvailableAt.getTime()
      : retryAvailableAt;
  const fallback = now + MEMBERSHIP_RETRY_FALLBACK_MS;
  const finiteRequested =
    typeof requested === "number" && Number.isFinite(requested)
      ? requested
      : fallback;
  return new Date(
    Math.min(
      Math.max(Math.ceil(finiteRequested), now + MEMBERSHIP_RETRY_MIN_DELAY_MS),
      now + MEMBERSHIP_RETRY_MAX_DELAY_MS,
    ),
  );
}

/** Recover a bounded, non-sensitive remaining delay from a serialized Next error. */
export function membershipRetryDelayFromDigest(
  digest: string | undefined,
): number | undefined {
  if (!digest) {
    return undefined;
  }
  const separator = `${MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST}:`;
  if (
    digest !== MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST &&
    !digest.startsWith(separator)
  ) {
    return undefined;
  }
  if (!digest.startsWith(separator)) {
    return MEMBERSHIP_RETRY_FALLBACK_MS;
  }
  const encoded = digest.slice(separator.length);
  if (!/^\d{1,7}$/.test(encoded)) {
    return MEMBERSHIP_RETRY_FALLBACK_MS;
  }
  const retryDelayMs = Number(encoded);
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < MEMBERSHIP_RETRY_MIN_DELAY_MS) {
    return MEMBERSHIP_RETRY_FALLBACK_MS;
  }
  return Math.min(retryDelayMs, MEMBERSHIP_RETRY_MAX_DELAY_MS);
}

/** Signals a retryable failure before any organization data is loaded. */
export class MembershipVerificationUnavailableError extends Error {
  readonly digest: string;

  constructor(retryAvailableAt?: Date | number, now = Date.now()) {
    super("GitHub membership verification is temporarily unavailable");
    this.name = "MembershipVerificationUnavailableError";
    const bounded = boundedMembershipRetryAvailableAt(retryAvailableAt, now);
    const retryDelayMs = bounded.getTime() - now;
    this.digest = `${MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST}:${retryDelayMs}`;
  }
}
