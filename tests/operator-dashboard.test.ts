import { afterEach, describe, expect, test } from "bun:test";

import { isOperatorUser } from "@/lib/operator-access";
import { parseOperatorReviewFilters } from "@/lib/operator-reviews";

const ORIGINAL_OPERATOR_IDS = process.env.POSTIL_OPERATOR_GITHUB_IDS;

afterEach(() => {
  if (ORIGINAL_OPERATOR_IDS === undefined) delete process.env.POSTIL_OPERATOR_GITHUB_IDS;
  else process.env.POSTIL_OPERATOR_GITHUB_IDS = ORIGINAL_OPERATOR_IDS;
});

describe("operator access", () => {
  test("allows only exact positive numeric GitHub ids from the operator allowlist", () => {
    process.env.POSTIL_OPERATOR_GITHUB_IDS = "123, 456, invalid, -7, 9007199254740993";

    expect(isOperatorUser({ githubId: 123 })).toBe(true);
    expect(isOperatorUser({ githubId: 456 })).toBe(true);
    expect(isOperatorUser({ githubId: 12 })).toBe(false);
    expect(isOperatorUser({ githubId: 789 })).toBe(false);
  });

  test("denies every user when the allowlist is unset", () => {
    delete process.env.POSTIL_OPERATOR_GITHUB_IDS;

    expect(isOperatorUser({ githubId: 123 })).toBe(false);
  });
});

describe("operator review filters", () => {
  test("normalizes supported filters and drops invalid date and status values", () => {
    expect(
      parseOperatorReviewFilters({
        org: " octo ",
        repo: ["postil-dev/postil"],
        status: "completed",
        from: "2026-07-01",
        to: "not-a-date",
      }),
    ).toEqual({
      org: "octo",
      repo: "postil-dev/postil",
      status: "completed",
      from: "2026-07-01",
      to: "",
    });

    expect(parseOperatorReviewFilters({ status: "deleted", from: "2026-7-1" }).status).toBe("");
    expect(parseOperatorReviewFilters({ status: "unavailable" }).status).toBe("unavailable");
  });
});
