import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EvidenceViewer,
  extractBreadcrumbs,
} from "@/components/evidence-viewer";
import { EVIDENCE_CASES, type EvidenceCase } from "@/data/evidence";

function evidenceCase(overrides: Partial<EvidenceCase> = {}): EvidenceCase {
  return {
    id: "case-one",
    category: "correctness",
    title: "Review evidence",
    blurb: "A real review case.",
    diff: "diff --git a/a.ts b/a.ts\n+const value = 1;",
    diffIsExcerpt: true,
    envelope: {
      checkRunTitle: "postil/review",
      summary: "Found one issue.",
      silent: false,
      findings: [],
      gate: {
        title: "postil/gate",
        summary: "Gate passing.",
        failOn: "error",
        failing: false,
      },
      modelUsed: "test-model",
    },
    sourceUrl: "https://github.com/postil-dev/postil/pull/42",
    checkRunUrl: "https://github.com/postil-dev/postil/actions/runs/1/job/2",
    gateCheckRunUrl: "https://github.com/postil-dev/postil/actions/runs/1/job/3",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    ...overrides,
  };
}

function evidenceLinks(markup: string): string {
  const match = markup.match(/<div class="ev-links">(?<links>.*?)<\/div>/);
  if (!match?.groups?.links) {
    throw new Error("rendered evidence links were not found");
  }
  return match.groups.links;
}

function evidenceLinkCount(markup: string): number {
  return (evidenceLinks(markup).match(/<a /g) ?? []).length;
}

describe("EvidenceViewer breadcrumbs", () => {
  test("renders three evidence links when a review URL is present", () => {
    const markup = renderToStaticMarkup(
      React.createElement(EvidenceViewer, {
        cases: [
          evidenceCase({
            reviewUrl:
              "https://github.com/postil-dev/postil/pull/42#discussion_r123",
          }),
        ],
      }),
    );

    expect(evidenceLinkCount(markup)).toBe(3);
    expect(evidenceLinks(markup)).toContain("repository");
    expect(evidenceLinks(markup)).toContain("pull request at commit");
    expect(evidenceLinks(markup)).toContain("review comment");
  });

  test("renders two evidence links when no review URL is present", () => {
    const markup = renderToStaticMarkup(
      React.createElement(EvidenceViewer, {
        cases: [evidenceCase()],
      }),
    );

    expect(evidenceLinkCount(markup)).toBe(2);
    expect(evidenceLinks(markup)).not.toContain("review comment");
  });
});

describe("extractBreadcrumbs", () => {
  test("keeps review URL fragments intact", () => {
    expect(
      extractBreadcrumbs(
        "https://github.com/postil-dev/postil/pull/42",
        "abc123",
        "https://github.com/postil-dev/postil/pull/42#discussion_r123",
      ),
    ).toEqual({
      repo: "https://github.com/postil-dev/postil",
      prFilesAtCommit:
        "https://github.com/postil-dev/postil/pull/42/files?sha=abc123",
      reviewComment:
        "https://github.com/postil-dev/postil/pull/42#discussion_r123",
    });
  });

  test("rejects malformed GitHub pull request URLs", () => {
    const malformedUrls = [
      "not a url",
      "https://github.com/postil-dev/postil/pulls/42",
      "https://github.com/postil-dev/postil/pull/not-a-number",
      "https://github.com/postil-dev/postil/pull/42/files",
      "https://github.com/postil-dev/postil/pull/42/",
      "https://github.com/postil-dev/postil/pull/42?tab=files",
    ];

    for (const sourceUrl of malformedUrls) {
      expect(() => extractBreadcrumbs(sourceUrl, "abc123")).toThrow(
        /sourceUrl must be (a valid GitHub pull request URL|a GitHub pull request URL)/,
      );
    }
  });

  test("rejects non-GitHub URLs", () => {
    const nonGithubUrls = [
      "http://github.com/postil-dev/postil/pull/42",
      "https://github.example.com/postil-dev/postil/pull/42",
      "https://example.com/postil-dev/postil/pull/42",
    ];

    for (const sourceUrl of nonGithubUrls) {
      expect(() => extractBreadcrumbs(sourceUrl, "abc123")).toThrow(
        "sourceUrl must be a GitHub pull request URL",
      );
    }
  });

  test("rejects review URLs that point to a different pull request", () => {
    const sourceUrl = "https://github.com/postil-dev/postil/pull/42";
    const mismatchedReviewUrls = [
      "https://github.com/other-org/postil/pull/42#discussion_r123",
      "https://github.com/postil-dev/other-repo/pull/42#discussion_r123",
      "https://github.com/postil-dev/postil/pull/43#discussion_r123",
    ];

    for (const reviewUrl of mismatchedReviewUrls) {
      expect(() => extractBreadcrumbs(sourceUrl, "abc123", reviewUrl)).toThrow(
        "reviewUrl must point to the same GitHub pull request",
      );
    }
  });

  test("matches the real evidence data review link shape", () => {
    const linkCounts = EVIDENCE_CASES.map((evidence) =>
      Object.keys(
        extractBreadcrumbs(
          evidence.sourceUrl,
          evidence.commitSha,
          evidence.reviewUrl,
        ),
      ).length,
    );

    expect(linkCounts).toEqual(
      EVIDENCE_CASES.map((evidence) => (evidence.reviewUrl ? 3 : 2)),
    );
  });
});
