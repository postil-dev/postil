import { describe, expect, test } from "bun:test";

import {
  deriveRepoHealth,
  type RepoHealthRow,
  type RepoHealthReviewStatus,
} from "@/lib/repo-health";

const NOW = new Date("2026-07-11T12:00:00.000Z");

function row(overrides: Partial<RepoHealthRow> = {}): RepoHealthRow {
  return {
    repositoryId: 1,
    repositoryFullName: "postil-dev/example",
    githubInstallationId: 42,
    accountLogin: "postil-dev",
    accountType: "Organization",
    lastEnabledAt: new Date("2026-07-10T12:00:00.000Z"),
    installationSuspended: false,
    attemptCount: 0,
    completedCount: 0,
    lastCompletedAt: null,
    latestAttemptStatus: null,
    latestAttemptAt: null,
    latestAttemptPublicId: null,
    ...overrides,
  };
}

function attempted(
  status: RepoHealthReviewStatus,
  attemptedAt = "2026-07-11T11:30:00.000Z",
): RepoHealthRow {
  return row({
    attemptCount: 1,
    latestAttemptStatus: status,
    latestAttemptAt: new Date(attemptedAt),
    latestAttemptPublicId: "177c6c58-b4ad-4a8d-b46c-bc099ed76736",
  });
}

describe("deriveRepoHealth", () => {
  test("returns awaiting-first-pr before seven silent days", () => {
    expect(deriveRepoHealth(row(), NOW)).toBe("awaiting-first-pr");
  });

  test("returns never-reviewed only after seven silent days", () => {
    expect(
      deriveRepoHealth(
        row({ lastEnabledAt: new Date("2026-07-04T12:00:00.000Z") }),
        NOW,
      ),
    ).toBe("awaiting-first-pr");
    expect(
      deriveRepoHealth(
        row({ lastEnabledAt: new Date("2026-07-04T11:59:59.999Z") }),
        NOW,
      ),
    ).toBe("never-reviewed");
  });

  test.each(["failed", "stale"] as const)(
    "returns failing immediately for a %s latest attempt",
    (status) => {
      expect(deriveRepoHealth(attempted(status), NOW)).toBe("failing");
    },
  );

  test.each(["queued", "running"] as const)(
    "returns failing when a %s latest attempt is over an hour old",
    (status) => {
      expect(
        deriveRepoHealth(attempted(status, "2026-07-11T10:59:59.999Z"), NOW),
      ).toBe("failing");
      expect(
        deriveRepoHealth(attempted(status, "2026-07-11T11:00:00.000Z"), NOW),
      ).toBe("healthy");
    },
  );

  test("suppresses warning states for a suspended installation", () => {
    expect(
      deriveRepoHealth(
        row({
          installationSuspended: true,
          lastEnabledAt: new Date("2026-06-01T12:00:00.000Z"),
        }),
        NOW,
      ),
    ).toBe("healthy");
    expect(
      deriveRepoHealth(
        attempted("failed", "2026-07-11T11:55:00.000Z"),
        NOW,
      ),
    ).toBe("failing");
    expect(
      deriveRepoHealth(
        {
          ...attempted("failed", "2026-07-11T11:55:00.000Z"),
          installationSuspended: true,
        },
        NOW,
      ),
    ).toBe("healthy");
  });

  test("returns healthy after any completion since enablement", () => {
    expect(
      deriveRepoHealth(
        {
          ...attempted("failed"),
          attemptCount: 3,
          completedCount: 1,
          lastCompletedAt: new Date("2026-07-10T13:00:00.000Z"),
        },
        NOW,
      ),
    ).toBe("healthy");
  });

  test("returns healthy while a recent attempt is in progress", () => {
    expect(deriveRepoHealth(attempted("queued"), NOW)).toBe("healthy");
  });
});
