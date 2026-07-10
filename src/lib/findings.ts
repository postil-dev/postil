import type { Finding, Severity } from "@/lib/envelope";

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/**
 * Display order for a review's findings: gate-relevant severity first, then
 * model confidence descending, then path for a stable tie-break.
 */
export function sortFindingsForDisplay(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.path.localeCompare(b.path);
  });
}
