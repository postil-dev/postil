import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observeGitHubReviewThreads } from "@/lib/github/publication-threads";
import {
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
