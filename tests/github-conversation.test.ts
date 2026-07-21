import { afterEach, describe, expect, test } from "bun:test";

import {
  boundedThreadContext,
  isAcceptableConversationRequest,
  isClarificationRequest,
  isGratitudeOnly,
  isPostilBotLogin,
  withoutPostilMention,
} from "@/lib/github/conversation";

const ORIGINAL_SLUG = process.env.GITHUB_APP_SLUG;

afterEach(() => {
  if (ORIGINAL_SLUG === undefined) delete process.env.GITHUB_APP_SLUG;
  else process.env.GITHUB_APP_SLUG = ORIGINAL_SLUG;
});

describe("GitHub conversation classification", () => {
  test("classifies gratitude without inference", () => {
    expect(isGratitudeOnly("@postil thanks again! 👍")).toBe(true);
    expect(isClarificationRequest("@postil thanks again! 👍")).toBe(false);
  });

  test("admits only bounded clarification-shaped implicit replies", () => {
    expect(isClarificationRequest("Why is this unsafe?" )).toBe(true);
    expect(isClarificationRequest("Please clarify the race" )).toBe(true);
    expect(isClarificationRequest("I changed the code" )).toBe(false);
    expect(isAcceptableConversationRequest("x".repeat(2_001))).toBe(false);
  });

  test("matches only the configured App bot login", () => {
    process.env.GITHUB_APP_SLUG = "postil-staging";
    expect(isPostilBotLogin("Postil-Staging[bot]")).toBe(true);
    expect(isPostilBotLogin("postil-dev[bot]")).toBe(false);
  });

  test("strips markers and bounds trusted thread context", () => {
    expect(withoutPostilMention("Please @postil explain")).toBe("Please  explain");
    expect(boundedThreadContext(`Review text\n\n<!-- postil-respond-job:7 -->`)).toBe(
      "Review text",
    );
    expect(boundedThreadContext("x".repeat(5_000))).toHaveLength(4_000);
  });
});
