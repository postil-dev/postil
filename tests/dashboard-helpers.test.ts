import { describe, expect, test } from "bun:test";

import type { Finding } from "@/lib/envelope";
import { sortFindingsForDisplay } from "@/lib/findings";
import { githubFileUrl, githubPrUrl } from "@/lib/github-links";
import { formatAbsoluteTimestamp, formatRelativeTime } from "@/lib/time";

function finding(overrides: Partial<Finding>): Finding {
  return {
    path: "src/a.ts",
    line: 1,
    severity: "info",
    kind: "risk",
    confidence: 0.5,
    title: "t",
    body: "b",
    ...overrides,
  };
}

describe("GitHub links", () => {
  test("builds a PR URL", () => {
    expect(githubPrUrl("postil-dev/postil", 42)).toBe(
      "https://github.com/postil-dev/postil/pull/42",
    );
  });

  test("builds a sha-pinned file permalink with the path encoded per segment", () => {
    expect(githubFileUrl("o/r", "abc123", "src/dir with space/f#1.ts", 7)).toBe(
      "https://github.com/o/r/blob/abc123/src/dir%20with%20space/f%231.ts#L7",
    );
  });

  test("uses a range anchor for multi-line findings and ignores a degenerate range", () => {
    expect(githubFileUrl("o/r", "abc", "a.ts", 7, 12)).toBe(
      "https://github.com/o/r/blob/abc/a.ts#L7-L12",
    );
    expect(githubFileUrl("o/r", "abc", "a.ts", 7, 7)).toBe(
      "https://github.com/o/r/blob/abc/a.ts#L7",
    );
  });
});

describe("Finding display order", () => {
  test("orders by severity, then confidence descending, then path", () => {
    const sorted = sortFindingsForDisplay([
      finding({ severity: "info", confidence: 0.9, path: "z.ts" }),
      finding({ severity: "error", confidence: 0.4, path: "b.ts" }),
      finding({ severity: "warn", confidence: 0.8, path: "a.ts" }),
      finding({ severity: "error", confidence: 0.9, path: "a.ts" }),
      finding({ severity: "warn", confidence: 0.8, path: "b.ts" }),
    ]);

    expect(
      sorted.map((f) => `${f.severity}:${f.confidence}:${f.path}`),
    ).toEqual([
      "error:0.9:a.ts",
      "error:0.4:b.ts",
      "warn:0.8:a.ts",
      "warn:0.8:b.ts",
      "info:0.9:z.ts",
    ]);
  });

  test("does not mutate its input", () => {
    const input = [
      finding({ severity: "info" }),
      finding({ severity: "error" }),
    ];
    sortFindingsForDisplay(input);
    expect(input[0]!.severity).toBe("info");
  });
});

describe("Review timestamps", () => {
  const now = Date.parse("2026-07-11T14:00:00.000Z");

  test("formats review start ages at useful dashboard precision", () => {
    expect(formatRelativeTime("2026-07-11T13:59:40.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-07-11T13:58:00.000Z", now)).toBe("2m ago");
    expect(formatRelativeTime("2026-07-11T11:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-07-08T14:00:00.000Z", now)).toBe("3d ago");
  });

  test("provides a stable absolute UTC timestamp for hover text", () => {
    expect(formatAbsoluteTimestamp("2026-07-11T13:58:00.000Z")).toBe(
      "2026-07-11 13:58:00 UTC",
    );
  });
});
