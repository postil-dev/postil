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

/**
 * Completed reviews whose operational sentinel is not already represented by
 * a narrower unrecovered model incident.
 *
 * The CLI emits `.postil/provider` with a scorer `providerError`, and emits one
 * `.postil/operational` or `.postil/model-output` sentinel with an
 * `invalidOutput` incident. Counting both shapes turns one upstream failure
 * into two operational signals. A second operational sentinel remains a
 * distinct failure, such as incomplete coverage.
 */
export const COMPLETED_REVIEW_OPERATIONAL_SENTINEL_SQL = `status = 'completed' AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(envelope -> 'findings') = 'array'
      THEN envelope -> 'findings' ELSE '[]'::jsonb END
  ) AS finding
  WHERE (
       finding ->> 'path' = '.postil/operational'
       AND (
         NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
               THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
           ) AS incident
           WHERE incident ->> 'category' = 'invalidOutput'
             AND incident ->> 'recovered' = 'false'
         )
         OR (
           SELECT count(*) FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(envelope -> 'findings') = 'array'
               THEN envelope -> 'findings' ELSE '[]'::jsonb END
           ) AS operational_finding
           WHERE operational_finding ->> 'path' = '.postil/operational'
         ) > 1
       )
     )
     OR (
       finding ->> 'path' = '.postil/provider'
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
             THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
         ) AS incident
         WHERE incident ->> 'phase' = 'scorer'
           AND incident ->> 'category' = 'providerError'
           AND incident ->> 'recovered' = 'false'
       )
     )
     OR (
       finding ->> 'path' = '.postil/model-output'
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
             THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
         ) AS incident
         WHERE incident ->> 'category' = 'invalidOutput'
           AND incident ->> 'recovered' = 'false'
       )
     )
)`;

/** A typed unrecovered scorer failure, excluding invalid output's own signal. */
export const COMPLETED_REVIEW_SCORER_FAILURE_SQL = `status = 'completed' AND (
  EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
        THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
    ) AS incident
    WHERE incident ->> 'phase' = 'scorer'
      AND incident ->> 'recovered' = 'false'
      AND (incident ->> 'category') IS DISTINCT FROM 'invalidOutput'
  )
  OR (
    NULLIF(btrim(envelope ->> 'scorerError'), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
          THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
      ) AS incident
      WHERE incident ->> 'phase' = 'scorer'
        AND incident ->> 'recovered' = 'false'
    )
  )
)`;

/** Invalid model output that the review pipeline could not repair or recover. */
export const COMPLETED_REVIEW_INVALID_OUTPUT_SQL = `status = 'completed' AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
      THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
  ) AS incident
  WHERE incident ->> 'category' = 'invalidOutput'
    AND incident ->> 'recovered' = 'false'
)`;

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
