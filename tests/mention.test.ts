import { describe, expect, test } from "bun:test";

import { mentionsPostil } from "@/lib/mentions";

describe("mentionsPostil", () => {
  test("matches a plain mention", () => {
    expect(mentionsPostil("@postil can you re-review this?")).toBe(true);
  });

  test("matches mid-sentence and is case-insensitive", () => {
    expect(mentionsPostil("hey @Postil what about line 12")).toBe(true);
  });

  test("ignores substrings that are not the whole handle", () => {
    expect(mentionsPostil("see postiljon@example.com")).toBe(false);
    expect(mentionsPostil("@postilbot is someone else")).toBe(false);
  });

  test("returns false for empty or absent text", () => {
    expect(mentionsPostil("")).toBe(false);
    expect(mentionsPostil(null)).toBe(false);
    expect(mentionsPostil(undefined)).toBe(false);
  });

  test("matches when wrapped in punctuation", () => {
    expect(mentionsPostil("(@postil)")).toBe(true);
    expect(mentionsPostil("cc: @postil.")).toBe(true);
  });
});
