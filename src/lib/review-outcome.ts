export const HOSTED_REVIEW_UNAVAILABLE_MESSAGE =
  "Hosted review service is temporarily unavailable.";

export type StoredReviewStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stale";

export type ReviewDisplayStatus = StoredReviewStatus | "unavailable";

export function isHostedReviewUnavailable(
  status: StoredReviewStatus,
  errorMessage: string | null,
): boolean {
  return status === "failed" && errorMessage === HOSTED_REVIEW_UNAVAILABLE_MESSAGE;
}

export function reviewDisplayStatus(
  status: StoredReviewStatus,
  errorMessage: string | null,
): ReviewDisplayStatus {
  return isHostedReviewUnavailable(status, errorMessage) ? "unavailable" : status;
}
