import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observeGitHubReviewThreads } from "@/lib/github/publication-threads";
import {
  parsePublicationReceipt,
  readPublicationReceipt,
  validateReceiptAgainstEnvelope,
} from "@/lib/publication-receipt";
import type { Envelope, Finding } from "@/lib/envelope";

const directories: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function finding(id: string): Finding {
  return {
    id,
    path: "src/example.ts",
    line: 3,
    severity: "warn",
    kind: "risk",
    confidence: 0.8,
    title: "Example finding",
    body: "A complete finding body.",
  };
}

function findingAt(id: string, path: string): Finding {
  return { ...finding(id), path };
}

function envelope(ids: string[]): Envelope {
  const findings = ids.map(finding);
  return {
    version: 1,
    summary: "",
    silent: findings.length === 0,
    findings,
    resolved: [],
    counts: { info: 0, warn: findings.length, error: 0, suppressed: 0, ungrounded: 0 },
    confidenceBuckets: [0, 0, 0, 0, findings.length],
    gate: { failOn: "error", failing: false },
    modelUsed: "test/model",
    usage: { promptTokens: 1, completionTokens: 1 },
    durationMs: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sinceSha: null,
  };
}

async function receiptFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "postil-publication-receipt-"));
  directories.push(directory);
  const path = join(directory, "receipt.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

describe("publication receipt contract", () => {
  test("validates the persisted wire contract in memory", () => {
    expect(parsePublicationReceipt({
      version: 2,
      channel: "reviewComments",
      receiptId: "github-review-v2:in-memory",
      findings: [{
        findingId: "carried-id",
        initialOutcome: "carried",
        commentId: "8000",
      }],
    })).toEqual({
      version: 2,
      channel: "reviewComments",
      receiptId: "github-review-v2:in-memory",
      findings: [{
        findingId: "carried-id",
        stableIdentity: true,
        initialOutcome: "carried",
        inlineRejected: false,
        commentId: "8000",
      }],
    });
    expect(() => parsePublicationReceipt({
      version: 2,
      channel: "reviewComments",
      receiptId: "github-review-v2:unknown-field",
      findings: [],
      untrusted: true,
    })).toThrow("publication receipt is invalid");
  });

  test("uses signed int64 decimal identities across the receipt wire contract", () => {
    expect(parsePublicationReceipt({
      version: 2,
      channel: "reviewComments",
      receiptId: "github-review-v2:int64",
      reviewId: "9223372036854775807",
      findings: [{
        findingId: "int64-comment",
        initialOutcome: "inline",
        commentId: "9223372036854775807",
      }],
    }).reviewId).toBe("9223372036854775807");
    expect(() => parsePublicationReceipt({
      version: 2,
      channel: "reviewComments",
      receiptId: "github-review-v2:too-large",
      reviewId: "9223372036854775808",
      findings: [],
    })).toThrow("publication receipt is invalid");
    expect(() => parsePublicationReceipt({
      version: 2,
      channel: "reviewComments",
      receiptId: "github-review-v2:malformed",
      reviewId: "not-a-decimal",
      findings: [],
    })).toThrow("publication receipt is invalid");
  });

  test("accepts one inline and one summary-only finding with forge identities", async () => {
    const receipt = await readPublicationReceipt(
      await receiptFile({
        version: 1,
        receiptId: "github-review-v1:123456",
        reviewId: "9001",
        findings: [
          {
            findingId: "inline-id",
            stableIdentity: true,
            initialOutcome: "inline",
            commentId: "8001",
          },
          {
            findingId: "summary-id",
            stableIdentity: true,
            initialOutcome: "summaryOnly",
          },
        ],
      }),
    );
    validateReceiptAgainstEnvelope(receipt, envelope(["inline-id", "summary-id"]));
    expect(receipt.reviewId).toBe("9001");
    expect(receipt.findings.map((entry) => entry.initialOutcome)).toEqual([
      "inline",
      "summaryOnly",
    ]);
  });

  test("accepts a version 2 check-annotation receipt without review comment identities", async () => {
    const receipt = await readPublicationReceipt(
      await receiptFile({
        version: 2,
        channel: "checkAnnotations",
        receiptId: "github-review-v2:123456",
        findings: [
          {
            findingId: "annotation-id",
            stableIdentity: true,
            initialOutcome: "checkAnnotation",
          },
          {
            findingId: "summary-id",
            stableIdentity: true,
            initialOutcome: "summaryOnly",
          },
        ],
      }),
    );
    validateReceiptAgainstEnvelope(receipt, envelope(["annotation-id", "summary-id"]));
    expect(receipt.channel).toBe("checkAnnotations");
    expect(receipt.reviewId).toBeUndefined();
    expect(receipt.findings.map((entry) => entry.initialOutcome)).toEqual([
      "checkAnnotation",
      "summaryOnly",
    ]);
  });

  test("accepts a version 2 file-level review comment with its GitHub identity", async () => {
    const receipt = await readPublicationReceipt(
      await receiptFile({
        version: 2,
        channel: "reviewComments",
        receiptId: "github-review-v2:file-comment",
        reviewId: "9005",
        findings: [
          {
            findingId: "file-comment-id",
            stableIdentity: true,
            initialOutcome: "fileComment",
            commentId: "8005",
          },
        ],
      }),
    );
    validateReceiptAgainstEnvelope(receipt, envelope(["file-comment-id"]));
    expect(receipt.findings[0]).toMatchObject({
      initialOutcome: "fileComment",
      commentId: "8005",
    });
  });

  test.each([
    {
      channel: "reviewComments",
      finding: { findingId: "missing-comment", initialOutcome: "fileComment" },
    },
    {
      channel: "checkAnnotations",
      finding: {
        findingId: "wrong-channel",
        initialOutcome: "fileComment",
        commentId: "8006",
      },
    },
  ])(
    "rejects an invalid file-level review comment receipt",
    async ({ channel, finding }) => {
      await expect(
        readPublicationReceipt(
          await receiptFile({
            version: 2,
            channel,
            receiptId: "github-review-v2:invalid-file-comment",
            findings: [finding],
          }),
        ),
      ).rejects.toThrow("publication receipt is invalid");
    },
  );

  test("rejects file-level comments in a version 1 receipt", async () => {
    await expect(
      readPublicationReceipt(
        await receiptFile({
          version: 1,
          receiptId: "github-review-v1:file-comment",
          findings: [
            {
              findingId: "version-one-file-comment",
              initialOutcome: "fileComment",
              commentId: "8007",
            },
          ],
        }),
      ),
    ).rejects.toThrow("publication receipt is invalid");
  });

  test("rejects publication outcomes that contradict the version 2 channel", async () => {
    await expect(
      readPublicationReceipt(
        await receiptFile({
          version: 2,
          channel: "checkAnnotations",
          receiptId: "github-review-v2:invalid",
          reviewId: "9004",
          findings: [
            {
              findingId: "inline-id",
              initialOutcome: "inline",
              commentId: "8004",
            },
          ],
        }),
      ),
    ).rejects.toThrow("publication receipt is invalid");
  });

  test.each([".postil/provider", ".postil/model-output"])(
    "accepts exact publishable populations when a forge receipt reports %s",
    (operationalPath) => {
      const reviewEnvelope = envelope([]);
      reviewEnvelope.findings = [
        finding("admitted-id"),
        findingAt("synthetic-id", ".postil/diff"),
        findingAt("operational-id", operationalPath),
      ];
      reviewEnvelope.resolved = [finding("resolved-id")];
      reviewEnvelope.suppressedFindings = [
        { finding: finding("suppressed-id"), reason: "belowConfidence" },
      ];
      reviewEnvelope.counts = {
        info: 0,
        warn: 2,
        error: 1,
        suppressed: 3,
        ungrounded: 4,
      };

      expect(() =>
        validateReceiptAgainstEnvelope(
          {
            version: 1,
            receiptId: "forge-review-v1:mixed",
            findings: [
              {
                findingId: "admitted-id",
                stableIdentity: true,
                initialOutcome: "inline",
                inlineRejected: false,
              },
              {
                findingId: "synthetic-id",
                stableIdentity: true,
                initialOutcome: "summaryOnly",
                inlineRejected: false,
              },
              {
                findingId: "operational-id",
                stableIdentity: true,
                initialOutcome: "unknown",
                inlineRejected: false,
              },
              {
                findingId: "resolved-id",
                stableIdentity: true,
                initialOutcome: "resolved",
                inlineRejected: false,
              },
              {
                findingId: "suppressed-id",
                stableIdentity: true,
                initialOutcome: "suppressed",
                inlineRejected: false,
              },
            ],
          },
          reviewEnvelope,
        ),
      ).not.toThrow();
    },
  );

  test("normalizes GitHub's 422 inline rejection as a summary-only receipt", async () => {
    const receipt = await readPublicationReceipt(
      await receiptFile({
        version: 1,
        receiptId: "github-review-v1:422422",
        reviewId: "9002",
        findings: [
          {
            findingId: "rejected-id",
            initialOutcome: "summaryOnly",
            inlineRejected: true,
          },
        ],
      }),
    );
    expect(receipt.findings[0]).toMatchObject({
      initialOutcome: "summaryOnly",
      inlineRejected: true,
    });
  });

  test("accepts an ambiguous write reconciled to existing GitHub identities", async () => {
    const receipt = await readPublicationReceipt(
      await receiptFile({
        version: 1,
        receiptId: "github-review-v1:ambiguous",
        reviewId: "9003",
        findings: [
          {
            findingId: "reconciled-id",
            initialOutcome: "inline",
            commentId: "8003",
          },
        ],
      }),
    );
    expect(receipt).toMatchObject({ reviewId: "9003" });
    expect(receipt.findings[0]?.commentId).toBe("8003");
  });

  test("accepts a carried finding naming the comment an earlier review left", async () => {
    const receipt = await readPublicationReceipt(
      await receiptFile({
        version: 1,
        receiptId: "github-review-v1:carried",
        reviewId: "9004",
        findings: [
          {
            findingId: "carried-id",
            initialOutcome: "carried",
            commentId: "8005",
          },
        ],
      }),
    );
    // The lifecycle pass observes threads by this identity, so a carried
    // finding without it leaves its live thread unobserved.
    expect(receipt.findings[0]?.commentId).toBe("8005");
  });

  test("rejects a comment identity on a finding that was never published", async () => {
    await expect(
      readPublicationReceipt(
        await receiptFile({
          version: 1,
          receiptId: "github-review-v1:unpublished",
          reviewId: "9005",
          findings: [
            {
              findingId: "summary-id",
              initialOutcome: "summaryOnly",
              commentId: "8006",
            },
          ],
        }),
      ),
    ).rejects.toThrow("only a published finding can carry a comment identity");
  });

  test("rejects public receipt permissions and cross-envelope identities", async () => {
    const path = await receiptFile({
      version: 1,
      receiptId: "github-review-v1:bad",
      findings: [{ findingId: "foreign", initialOutcome: "summaryOnly" }],
    });
    await chmod(path, 0o644);
    await expect(readPublicationReceipt(path)).rejects.toThrow("permissions are not private");
    await chmod(path, 0o600);
    const receipt = await readPublicationReceipt(path);
    expect(() => validateReceiptAgainstEnvelope(receipt, envelope(["local"]))).toThrow(
      "publication receipt",
    );
  });
});

describe("GitHub publication thread observations", () => {
  test("uses thread flags and absence, not replies or review dismissal", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-11",
                      isResolved: true,
                      isOutdated: false,
                      comments: {
                        nodes: [{ databaseId: 11 }, { databaseId: 91 }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                    {
                      id: "thread-12",
                      isResolved: false,
                      isOutdated: true,
                      comments: {
                        nodes: [{ databaseId: 12 }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                    {
                      id: "thread-13",
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [{ databaseId: 13 }, { databaseId: 92 }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    expect(
      await observeGitHubReviewThreads("token", "owner/repo", 4, ["11", "12", "13", "14"]),
    ).toEqual([
      { githubCommentId: "11", state: "resolved" },
      { githubCommentId: "12", state: "outdated" },
      { githubCommentId: "13", state: "inline" },
      { githubCommentId: "14", state: "deleted" },
    ]);
  });

  test("paginates comments within a review thread before classifying absence", async () => {
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{
                    id: "thread-paged",
                    isResolved: true,
                    isOutdated: false,
                    comments: {
                      nodes: [{ databaseId: 91 }],
                      pageInfo: { hasNextPage: true, endCursor: "comment-page-2" },
                    },
                  }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }));
      }
      return new Response(JSON.stringify({
        data: {
          node: {
            comments: {
              nodes: [{ databaseId: 11 }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }));
    }) as unknown as typeof fetch;

    expect(await observeGitHubReviewThreads("token", "owner/repo", 4, ["11"])).toEqual([
      { githubCommentId: "11", state: "resolved" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.variables).toEqual({
      threadId: "thread-paged",
      commentsCursor: "comment-page-2",
    });
  });
});
