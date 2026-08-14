import { isEnvelopeOperationallyUnavailable, type Envelope, type Finding } from "@/lib/envelope";
import { sortFindingsForDisplay } from "@/lib/findings";

export function partitionRunFindingsForPresentation(
  envelope: Pick<Envelope, "findings"> | null,
): {
  operationalDiagnostics: Finding[];
  reviewerFindings: Finding[];
  noReviewerVerdict: boolean;
} {
  const findings = envelope ? sortFindingsForDisplay(envelope.findings) : [];
  const noReviewerVerdict = Boolean(
    envelope && isEnvelopeOperationallyUnavailable(envelope),
  );
  return {
    operationalDiagnostics: noReviewerVerdict ? findings : [],
    reviewerFindings: noReviewerVerdict ? [] : findings,
    noReviewerVerdict,
  };
}
