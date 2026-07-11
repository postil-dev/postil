import { describe, expect, test } from "bun:test";

import { extractBreadcrumbs } from "@/components/evidence-viewer";

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

  test("throws when reviewUrl points to a different pull request", () => {
    expect(() =>
      extractBreadcrumbs(
        "https://github.com/postil-dev/postil/pull/275",
        "4d08309409e3b250cca5db5f53527e39a3a71ef9",
        "https://github.com/postil-dev/postil/pull/276#discussion_r1234567890",
      ),
    ).toThrow("reviewUrl must point to the same GitHub pull request");
  });
});
