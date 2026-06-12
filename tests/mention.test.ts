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

  test("matches plain and mid-sentence mentions", () => {
    expect(mentionsPostil("@postil")).toBe(true);
    expect(mentionsPostil("hey @postil, look")).toBe(true);
  });

  test("does not match other handles that merely start with postil", () => {
    // GitHub handles allow hyphens; these are different accounts/orgs.
    expect(mentionsPostil("@postil-dev/maintainers please review")).toBe(false);
    expect(mentionsPostil("use @postil-action in CI")).toBe(false);
    expect(mentionsPostil("install @postil-cli first")).toBe(false);
  });

  test("ignores mentions inside fenced code blocks", () => {
    expect(mentionsPostil("example:\n```\nsay @postil to summon the bot\n```\nend")).toBe(false);
    expect(mentionsPostil("```yaml\ncomment: '@postil'\n```")).toBe(false);
    // Unterminated fences render as code to the end of the comment.
    expect(mentionsPostil("```\n@postil")).toBe(false);
  });

  test("ignores mentions inside inline code spans", () => {
    expect(mentionsPostil("type `@postil` in a comment")).toBe(false);
  });

  test("still matches prose mentions next to code", () => {
    expect(mentionsPostil("`config` @postil what does this do?")).toBe(true);
    expect(mentionsPostil("```\nsome code\n```\n@postil thoughts?")).toBe(true);
  });
});
