import { isOperationalFinding } from "@/lib/envelope";

export const HOSTED_REVIEW_UNAVAILABLE_MESSAGE =
  "Hosted review service is temporarily unavailable.";

export const HOSTED_ALLOWANCE_UNAVAILABLE_MESSAGE =
  "Hosted inference allowance is unavailable or fully reserved.";

export const PUBLICATION_INELIGIBLE_MESSAGE =
  "pull request is no longer eligible for publication";

/**
 * Terminal review failures that are not service faults.
 *
 * Each names an outcome the service reached correctly: allowance it declined to
 * oversell, a dependency it reported as unavailable, or a pull request that was
 * closed, merged, drafted, or moved to another head while its review was in
 * flight. Counting these as operational failures pages an operator about a
 * working system, so monitoring excludes them.
 */
export const NON_OPERATIONAL_REVIEW_FAILURE_MESSAGES = [
  HOSTED_ALLOWANCE_UNAVAILABLE_MESSAGE,
  HOSTED_REVIEW_UNAVAILABLE_MESSAGE,
  PUBLICATION_INELIGIBLE_MESSAGE,
] as const;

/**
 * SQL predicate matching a failed review that is a genuine service fault.
 *
 * Monitoring reads reviews with raw SQL in more than one place, and a message
 * list that drifts between them reports different fleet health depending on
 * which query answered. A missing `error_message` stays operational: an
 * unattributed failure is the kind worth waking someone for.
 */
export const OPERATIONAL_REVIEW_FAILURE_SQL = `status = 'failed' AND COALESCE(error_message, '') <> ALL (ARRAY[${NON_OPERATIONAL_REVIEW_FAILURE_MESSAGES.map(
  (message) => `'${message.replaceAll("'", "''")}'`,
).join(", ")}])`;

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
