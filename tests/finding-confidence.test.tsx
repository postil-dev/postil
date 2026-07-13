import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  confidenceExplanation,
  FindingConfidenceDetails,
  FindingConfidenceLabel,
} from "@/components/finding-confidence";
import type { Finding } from "@/lib/envelope";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: "src/review.ts",
    line: 42,
    severity: "warn",
    kind: "risk",
    confidence: 0.72,
    title: "A finding",
    body: "Finding body",
    ...overrides,
  };
}

describe("finding confidence display", () => {
  test("explains equal reviewer and independent-check scores", () => {
    expect(
      confidenceExplanation(
        finding({ generatorConfidence: 0.72, scorerConfidence: 0.72 }),
      )?.calculation,
    ).toBe(
      "The reviewer and independent check both scored this finding at 72%. Final confidence is 72%.",
    );
  });

  test("explains that the final value is the lower of different scores", () => {
    expect(
      confidenceExplanation(
        finding({
          confidence: 0.7,
          generatorConfidence: 0.7,
          scorerConfidence: 0.75,
        }),
      )?.calculation,
    ).toBe(
      "Postil uses the more cautious score: reviewer 70%, independent check 75%, final 70%.",
    );
  });

  test("explains legacy component fields without inventing the missing score", () => {
    expect(
      confidenceExplanation(finding({ scorerConfidence: 0.72 }))?.calculation,
    ).toBe(
      "Final confidence is 72%. Independent-check confidence is 72%; the reviewer score is not recorded for this run.",
    );
  });

  test("keeps the confidence definition accessible when no independent check ran", () => {
    const markup = renderToStaticMarkup(
      <FindingConfidenceDetails finding={finding()} />,
    );

    expect(markup).toContain("Confidence details");
    expect(markup).toContain(
      "Final confidence is 72%. No independent check is recorded for this finding.",
    );
  });

  test("renders one primary confidence and keeps the assessment out of hover text", () => {
    const assessed = finding({
      generatorConfidence: 0.8,
      scorerConfidence: 0.72,
      scorerReason: "The changed branch can skip the required write.",
    });
    const markup = renderToStaticMarkup(
      <>
        <FindingConfidenceLabel finding={assessed} />
        <FindingConfidenceDetails finding={assessed} />
      </>,
    );

    expect(markup).toContain("confidence 72%");
    expect(markup).toContain("Confidence details");
    expect(markup).toContain("Independent assessment:");
    expect(markup).toContain("The changed branch can skip the required write.");
    expect(markup).toContain(
      'title="Final confidence used for policy filtering and gating."',
    );
    expect(markup).not.toContain(
      'title="The changed branch can skip the required write."',
    );
    expect(markup).not.toContain("scorer 0.72");
  });
});
