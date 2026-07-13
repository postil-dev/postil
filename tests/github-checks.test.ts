import { afterEach, describe, expect, test } from "bun:test";

import {
  findIssueCommentByMarker,
  getPullRequestReviewContext,
  RESPOND_MARKER_MAX_PAGES,
} from "@/lib/github/checks";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function comments(count: number, page: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: page * 1_000 + index,
    body: `comment ${page}-${index}`,
  }));
}

describe("respond delivery marker lookup", () => {
  test("finds a marker after the first 100 issue comments", async () => {
    const requestedPages: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      const body = comments(page === 1 ? 100 : 4, page);
      if (page === 2) body[2]!.body += " <!-- postil-respond-job:42 -->";
      return Response.json(body);
    }) as typeof fetch;

    const found = await findIssueCommentByMarker(
      "token",
      "postil-dev/postil",
      7,
      "<!-- postil-respond-job:42 -->",
      new Date("2026-07-13T00:00:00.000Z"),
    );

    expect(found).toBe(2_002);
    expect(requestedPages).toEqual([1, 2]);
  });

  test("fails closed after the bounded search window is full", async () => {
    const requestedPages: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      return Response.json(comments(100, page));
    }) as typeof fetch;

    const lookup = findIssueCommentByMarker(
      "token",
      "postil-dev/postil",
      7,
      "<!-- postil-respond-job:missing -->",
      new Date("2026-07-13T00:00:00.000Z"),
    );

    await expect(lookup).rejects.toThrow("marker search is inconclusive");
    expect(requestedPages).toHaveLength(RESPOND_MARKER_MAX_PAGES);
    expect(requestedPages.at(-1)).toBe(RESPOND_MARKER_MAX_PAGES);
  });

  test("returns null when a short page proves the search is exhausted", async () => {
    globalThis.fetch = (async (_input) => Response.json(comments(3, 1))) as typeof fetch;

    const found = await findIssueCommentByMarker(
      "token",
      "postil-dev/postil",
      7,
      "<!-- postil-respond-job:missing -->",
      new Date("2026-07-13T00:00:00.000Z"),
    );

    expect(found).toBeNull();
  });
});

describe("pull-request review context", () => {
  test("loads immutable refs and optional author identity", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        draft: false,
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
        user: { id: 42, login: "octocat" },
      })) as typeof fetch;

    await expect(getPullRequestReviewContext("token", "octo/repo", 7)).resolves.toEqual({
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
      authorGithubId: 42,
      authorLogin: "octocat",
    });
  });

  test("fails closed when either immutable ref is absent", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({ head: { sha: "head-sha" }, base: {} })) as typeof fetch;

    await expect(getPullRequestReviewContext("token", "octo/repo", 7)).rejects.toThrow(
      "incomplete refs",
    );
  });
});
