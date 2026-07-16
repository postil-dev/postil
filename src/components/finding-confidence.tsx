import type { Finding } from "@/lib/envelope";

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface ConfidenceExplanation {
  calculation: string;
  assessment: string | null;
}

/** Explain the stored final confidence without hiding either model input. */
export function confidenceExplanation(finding: Finding): ConfidenceExplanation {
  const reviewer = finding.generatorConfidence;
  const independentCheck = finding.scorerConfidence;
  const final = formatConfidence(finding.confidence);
  let calculation: string;
  if (reviewer !== undefined && independentCheck !== undefined) {
    const reviewerText = formatConfidence(reviewer);
    const independentCheckText = formatConfidence(independentCheck);
    const expectedFinal = Math.min(reviewer, independentCheck);
    if (Math.abs(finding.confidence - expectedFinal) > Number.EPSILON) {
      calculation =
        `This run records reviewer confidence ${reviewerText}, independent-check confidence ` +
        `${independentCheckText}, and final confidence ${final}.`;
    } else if (reviewer === independentCheck) {
      calculation =
        `The reviewer and independent check both scored this finding at ${final}. ` +
        `Final confidence is ${final}.`;
    } else {
      calculation =
        `Postil uses the more cautious score: reviewer ${reviewerText}, independent check ` +
        `${independentCheckText}, final ${final}.`;
    }
  } else if (reviewer !== undefined) {
    calculation =
      `Final confidence is ${final}. Reviewer confidence is ${formatConfidence(reviewer)}; ` +
      "the independent-check score is not recorded for this run.";
  } else if (independentCheck !== undefined) {
    calculation =
      `Final confidence is ${final}. Independent-check confidence is ` +
      `${formatConfidence(independentCheck)}; the reviewer score is not recorded for this run.`;
  } else {
    calculation =
      `Final confidence is ${final}. No independent check is recorded for this finding.`;
  }

  return {
    calculation,
    assessment: finding.scorerReason?.trim() || null,
  };
}

export function FindingConfidenceLabel({ finding }: { finding: Finding }) {
  return (
    <span
      className="font-mono text-[11px] text-charcoal/70"
      title="Final confidence used for policy filtering and gating."
    >
      confidence {formatConfidence(finding.confidence)}
    </span>
  );
}

export function FindingConfidenceDetails({ finding }: { finding: Finding }) {
  const explanation = confidenceExplanation(finding);

  return (
    <details className="mt-3 text-xs text-charcoal/70">
      <summary className="cursor-pointer font-medium">Confidence details</summary>
      <p className="mt-1">{explanation.calculation}</p>
      {explanation.assessment && (
        <p className="mt-1">
          <span className="font-medium">Independent assessment:</span>{" "}
          {explanation.assessment}
        </p>
      )}
    </details>
  );
}
