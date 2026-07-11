import { describe, expect, test } from "bun:test";

import {
  calculateBillingUsage,
  currentMonthBillingPeriod,
  formatRepoDays,
  type RepositoryEnablementEventForBilling,
} from "@/lib/billing-usage";

const day = 24 * 60 * 60 * 1000;

function event(
  id: number,
  repositoryId: number,
  fullName: string,
  repositoryPrivate: boolean,
  action: "enable" | "disable",
  occurredAt: string,
): RepositoryEnablementEventForBilling {
  return {
    id,
    repositoryId,
    githubRepoId: 1000 + repositoryId,
    repositoryFullName: fullName,
    repositoryPrivate,
    action,
    occurredAt: new Date(occurredAt),
  };
}

describe("billing usage calculations", () => {
  test("computes current month repo-days across enabled and disabled intervals", () => {
    const period = {
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-07-11T00:00:00.000Z"),
    };

    const usage = calculateBillingUsage(
      [
        event(1, 1, "octo/public", false, "enable", "2026-06-20T00:00:00.000Z"),
        event(2, 2, "octo/private", true, "enable", "2026-07-03T00:00:00.000Z"),
        event(3, 2, "octo/private", true, "disable", "2026-07-06T12:00:00.000Z"),
        event(4, 2, "octo/private", true, "enable", "2026-07-09T00:00:00.000Z"),
        event(5, 3, "octo/disabled", false, "enable", "2026-07-02T00:00:00.000Z"),
        event(6, 3, "octo/disabled", false, "disable", "2026-07-04T00:00:00.000Z"),
      ],
      period,
    );

    expect(usage.totalEnabledMs / day).toBe(17.5);
    expect(usage.totalRepoDays).toBe(17.5);
    expect(usage.enabledPublicCount).toBe(1);
    expect(usage.enabledPrivateCount).toBe(1);
    expect(usage.currentEnabledRepositories.map((repo) => repo.repositoryFullName)).toEqual([
      "octo/private",
      "octo/public",
    ]);
    expect(
      usage.currentEnabledRepositories.find((repo) => repo.repositoryFullName === "octo/public")
        ?.enabledSince,
    ).toEqual(new Date("2026-06-20T00:00:00.000Z"));
  });

  test("uses event order to ignore repeated same-state edges", () => {
    const period = {
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-07-04T00:00:00.000Z"),
    };

    const usage = calculateBillingUsage(
      [
        event(1, 1, "octo/repo", false, "enable", "2026-07-01T00:00:00.000Z"),
        event(2, 1, "octo/repo", false, "enable", "2026-07-02T00:00:00.000Z"),
        event(3, 1, "octo/repo", false, "disable", "2026-07-03T00:00:00.000Z"),
      ],
      period,
    );

    expect(usage.totalRepoDays).toBe(2);
    expect(usage.currentEnabledRepositories).toEqual([]);
  });

  test("returns the current UTC month billing period", () => {
    expect(currentMonthBillingPeriod(new Date("2026-07-11T12:34:56.000Z"))).toEqual({
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-07-11T12:34:56.000Z"),
    });
  });

  test("formats repo-days compactly", () => {
    expect(formatRepoDays(0)).toBe("0");
    expect(formatRepoDays(0.25)).toBe("0.25");
    expect(formatRepoDays(15.555)).toBe("15.6");
  });
});
