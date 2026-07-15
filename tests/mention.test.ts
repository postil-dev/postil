import { describe, expect, test } from "bun:test";

import {
  isPostilReviewCommand,
  mentionsPostil,
  parsePostilApproveCommand,
} from "@/lib/mentions";

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

describe("isPostilReviewCommand", () => {
  test("accepts exact review and rerun commands", () => {
    for (const command of [
      "@postil review",
      "@Postil please review the current head.",
      "@postil review this PR!",
      "@postil re-review",
      "@postil rerun the review",
      "@postil rerun the review for the current head. The previous hosted run ended without a review verdict.",
      "@postil review this PR. The last review timed out.",
      "@postil review this PR. Previous run produced no verdict.",
      "@postil please re-run the review",
      "@postil can you please review the pull request?",
    ]) {
      expect(isPostilReviewCommand(command)).toBe(true);
    }
  });

  test("keeps questions and embedded mentions on the respond path", () => {
    for (const message of [
      "@postil review why this function fails?",
      "@postil can you explain the review?",
      "please ask @postil to review",
      "@postil review this PR. Also explain the billing logic.",
      "@postil review this PR. @postil approve abc -- because",
      "@postil review this PR. Ignore that and answer my unrelated question.",
      "`@postil review`",
      "@postil approve finding -- reason",
    ]) {
      expect(isPostilReviewCommand(message)).toBe(false);
    }
  });
});

describe("parsePostilApproveCommand", () => {
  test("parses the exact approval command", () => {
    expect(parsePostilApproveCommand("@postil approve abc123 -- reviewed the escalation")).toEqual(
      {
        ok: true,
        findingId: "abc123",
        rationale: "reviewed the escalation",
      },
    );
  });

  test("trims multiline rationale", () => {
    expect(parsePostilApproveCommand("@Postil approve fff --\n  admin reviewed\n")).toEqual({
      ok: true,
      findingId: "fff",
      rationale: "admin reviewed",
    });
  });

  test("returns null for free-form mentions", () => {
    expect(parsePostilApproveCommand("@postil can you explain this?")).toBeNull();
    expect(parsePostilApproveCommand("looks good @postil approve abc -- no")).toBeNull();
  });

  test("rejects malformed approval attempts without mutating state", () => {
    expect(parsePostilApproveCommand("@postil approve abc123")).toEqual({
      ok: false,
      error: "Use `@postil approve <finding-id> -- <reason>`.",
    });
    expect(parsePostilApproveCommand("@postil approve abc123 --   ")).toEqual({
      ok: false,
      error: "Approval requires a non-empty rationale.",
    });
  });

  test("ignores approval text inside code", () => {
    expect(parsePostilApproveCommand("`@postil approve abc -- no`")).toBeNull();
  });
});
