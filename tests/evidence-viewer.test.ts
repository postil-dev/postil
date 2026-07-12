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
  test("returns repository, commit-pinned PR files, and review comment links", () => {
    expect(
      extractBreadcrumbs(
        "https://github.com/postil-dev/postil/pull/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
        "https://github.com/postil-dev/postil/pull/275#discussion_r1234567890",
      ),
    ).toEqual({
      repo: "https://github.com/postil-dev/postil",
      prFilesAtCommit:
        "https://github.com/postil-dev/postil/pull/275/files?sha=4d08309409e3b250cca5db5f53527e39a3a71ef9",
      reviewComment:
        "https://github.com/postil-dev/postil/pull/275#discussion_r1234567890",
    });
  });

  test("returns two links for silent evidence without a review comment", () => {
    expect(
      extractBreadcrumbs(
        "https://github.com/postil-dev/postil/pull/295",
        "5976fccf72ef93dbf5b175482fac1c79cb9890f2",
      ),
    ).toEqual({
      repo: "https://github.com/postil-dev/postil",
      prFilesAtCommit:
        "https://github.com/postil-dev/postil/pull/295/files?sha=5976fccf72ef93dbf5b175482fac1c79cb9890f2",
    });
  });

  test("ignores source URL fragments when building commit-pinned PR files", () => {
    expect(
      extractBreadcrumbs(
        "https://github.com/postil-dev/postil/pull/275#discussion_r1234567890",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
      ),
    ).toEqual({
      repo: "https://github.com/postil-dev/postil",
      prFilesAtCommit:
        "https://github.com/postil-dev/postil/pull/275/files?sha=4d08309409e3b250cca5db5f53527e39a3a71ef9",
    });
  });

  test("throws for malformed URLs", () => {
    expect(() =>
      extractBreadcrumbs("not a url", "4d08309409e3b250cca5db5f53527e39a3a71ef9"),
    ).toThrow("sourceUrl must be a valid GitHub pull request URL");
  });

  test("throws for non-GitHub source URLs", () => {
    expect(() =>
      extractBreadcrumbs(
        "https://gitlab.com/postil-dev/postil/-/merge_requests/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
      ),
    ).toThrow("sourceUrl must be a GitHub pull request URL");
  });

  test("throws when sourceUrl contains embedded username", () => {
    expect(() =>
      extractBreadcrumbs(
        "https://user@github.com/postil-dev/postil/pull/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
      ),
    ).toThrow("sourceUrl must not contain embedded credentials");
  });

  test("throws when sourceUrl contains embedded password", () => {
    expect(() =>
      extractBreadcrumbs(
        "https://user:password@github.com/postil-dev/postil/pull/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
      ),
    ).toThrow("sourceUrl must not contain embedded credentials");
  });

  test("throws when reviewUrl contains embedded username", () => {
    expect(() =>
      extractBreadcrumbs(
        "https://github.com/postil-dev/postil/pull/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
        "https://token@github.com/postil-dev/postil/pull/275#discussion_r123",
      ),
    ).toThrow("reviewUrl must not contain embedded credentials");
  });

  test("throws when reviewUrl contains embedded password", () => {
    expect(() =>
      extractBreadcrumbs(
        "https://github.com/postil-dev/postil/pull/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
        "https://user:token@github.com/postil-dev/postil/pull/275#discussion_r123",
      ),
    ).toThrow("reviewUrl must not contain embedded credentials");
  });

  test("throws when reviewUrl points to a different pull request", () => {
    expect(() =>
      extractBreadcrumbs(
        "https://github.com/postil-dev/postil/pull/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
        "https://github.com/postil-dev/postil/pull/276#discussion_r1234567890",
      ),
    ).toThrow("reviewUrl must point to the same GitHub pull request");
  });

  test("accepts case-insensitive GitHub owner and repository matches", () => {
    expect(
      extractBreadcrumbs(
        "https://github.com/Postil-Dev/Postil/pull/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
        "https://github.com/postil-dev/postil/pull/275#discussion_r1234567890",
      ),
    ).toMatchObject({
      reviewComment:
        "https://github.com/postil-dev/postil/pull/275#discussion_r1234567890",
    });
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
