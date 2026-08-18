import { isOperationalFinding } from "@/lib/envelope";

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

/**
 * Detect an operational sentinel in a stored envelope.
 *
 * Reviews are read straight from the `jsonb` column on hot paths, so this
 * tolerates an unvalidated shape rather than forcing a schema parse. The
 * sentinel path list itself is not restated here; `isOperationalFinding` owns it.
 */
export function storedEnvelopeOperationallyUnavailable(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== "object") return false;
  const findings = (envelope as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return false;
  return findings.some((finding) => {
    const path = (finding as { path?: unknown })?.path;
    return typeof path === "string" && isOperationalFinding({ path });
  });
}

/**
 * Status to show for a stored review.
 *
 * A review whose envelope carries an operational sentinel never reached a
 * verdict, however the row was stored: the model output failed validation, or
 * the provider failed. The GitHub check for the same run concludes `failure`,
 * so the dashboard reports it as failed rather than letting `completed` plus a
 * non-failing gate read as a clean pass. The gate is reported separately and
 * keeps its own state.
 */
export function reviewDisplayStatus(
  status: StoredReviewStatus,
  errorMessage: string | null,
  envelope?: unknown,
): ReviewDisplayStatus {
  if (isHostedReviewUnavailable(status, errorMessage)) return "unavailable";
  if (storedEnvelopeOperationallyUnavailable(envelope)) return "failed";
  return status;
}
