import { afterEach, describe, expect, test } from "bun:test";

import {
  findIssueCommentByMarker,
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

  test("stops after the bounded search window when the marker is absent", async () => {
    const requestedPages: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      return Response.json(comments(100, page));
    }) as typeof fetch;

    const found = await findIssueCommentByMarker(
      "token",
      "postil-dev/postil",
      7,
      "<!-- postil-respond-job:missing -->",
      new Date("2026-07-13T00:00:00.000Z"),
    );

    expect(found).toBeNull();
    expect(requestedPages).toHaveLength(RESPOND_MARKER_MAX_PAGES);
    expect(requestedPages.at(-1)).toBe(RESPOND_MARKER_MAX_PAGES);
  });
});
