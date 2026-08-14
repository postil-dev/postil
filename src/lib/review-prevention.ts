import { parseStoredEnvelope, type Envelope, type Finding } from "@/lib/envelope";

const OPERATIONAL_PATHS = new Set([
  ".postil/provider",
  ".postil/model-output",
  ".postil/operational",
]);

function findingIdentity(finding: Finding): string {
  // CLI finding IDs include the reviewed head SHA, and line numbers can move
  // between revisions. Coaching frequency needs a head-independent issue key,
  // not the exact annotation identity used for approvals and reconciliation.
  return [finding.path, finding.kind, finding.title]
    .map((part) => String(part).trim().toLowerCase())
    .join(":");
}

function actionableFindingIds(envelope: Envelope): Set<string> {
  return new Set(
    envelope.findings
      .filter((finding) => !OPERATIONAL_PATHS.has(finding.path))
      .map(findingIdentity),
  );
}

/**
 * Coaching starts only after a completed review has introduced at least one
 * actionable finding on this pull request. Silent and operational-only reviews
 * never arm the prompt. Repeated prior reviews carrying only the same finding
 * do not keep rearming it on every later revision.
 */
export function priorReviewsWarrantPreventionHint(
  newest: Envelope | null,
  previous: Envelope | null,
): boolean {
  if (!newest || newest.silent) return false;
  const newestIds = actionableFindingIds(newest);
  if (newestIds.size === 0) return false;
  if (!previous) return true;
  const previousIds = actionableFindingIds(previous);
  return [...newestIds].some((id) => !previousIds.has(id));
}

export function parsedPriorReviewsWarrantPreventionHint(rows: readonly unknown[]): boolean {
  const parsed = rows.map(parseStoredEnvelope);
  return priorReviewsWarrantPreventionHint(parsed[0] ?? null, parsed[1] ?? null);
}
