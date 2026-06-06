import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = [
  {
    id: "review-1",
    organizationSlug: "acme",
    repoFullName: "acme/widget",
    pullNumber: 42,
    headSha: "abc123",
    status: "completed",
    checkRunId: 7,
    triggerRunId: "run-1",
    result: { summary: "done", findings: [{ path: "src/a.ts" }] },
    errorMessage: null,
    createdAt: new Date("2026-06-01T10:00:00Z"),
    completedAt: new Date("2026-06-01T10:02:00Z"),
  },
];

const dbMock = {
  rows,
  select: vi.fn(() => ({
    from: () => {
      const ordered = {
        limit: async () => rows,
      };
      const joined = {
        innerJoin: () => joined,
        orderBy: () => ordered,
        where: () => ({
          limit: async () => rows,
          orderBy: () => ordered,
        }),
      };

      return {
        innerJoin: () => joined,
      };
    },
  })),
};

vi.mock("@/db", () => ({
  getDb: () => dbMock,
  schema: {
    organizations: { id: "organization_id", slug: "organization_slug" },
    users: {
      email: "user_email",
      githubLogin: "user_github_login",
    },
    reviews: {
      id: "id",
      organizationId: "review_organization_id",
      repoFullName: "repo_full_name",
      pullNumber: "pull_number",
      headSha: "head_sha",
      status: "status",
      checkRunId: "check_run_id",
      triggerRunId: "trigger_run_id",
      result: "result",
      errorMessage: "error_message",
      createdAt: "created_at",
      completedAt: "completed_at",
    },
  },
}));

const { getReviewReport, listReviewReports, reportViewerFromSession, reviewFindingCount } =
  await import("./reports");

describe("report helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts findings only when result has a findings array", () => {
    expect(reviewFindingCount({ findings: [{}, {}] })).toBe(2);
    expect(reviewFindingCount({ findings: "none" })).toBe(0);
    expect(reviewFindingCount(null)).toBe(0);
  });

  it("extracts report viewers from signed-in sessions", () => {
    expect(
      reportViewerFromSession({
        user: { email: " user@example.test " },
        session: { activeOrganizationId: " org-123 " },
      }),
    ).toEqual({
      email: "user@example.test",
      organizationId: "org-123",
    });
    expect(
      reportViewerFromSession({
        user: {},
        session: { activeOrganizationId: "org-123" },
      }),
    ).toBeNull();
    expect(
      reportViewerFromSession({
        user: { email: "user@example.test" },
        session: {},
      }),
    ).toBeNull();
    expect(reportViewerFromSession(null)).toBeNull();
  });

  it("does not query reports without an authorized viewer", async () => {
    await expect(listReviewReports({ viewer: null })).resolves.toEqual([]);
    await expect(getReviewReport("review-1", null)).resolves.toBeNull();
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("maps persisted reviews into report summaries", async () => {
    const reports = await listReviewReports({
      viewer: {
        email: "user@example.test",
        organizationId: "review_organization_id",
      },
    });

    expect(reports).toEqual([
      expect.objectContaining({
        id: "review-1",
        repoFullName: "acme/widget",
        findingCount: 1,
      }),
    ]);
  });

  it("returns detail with the raw result payload", async () => {
    const report = await getReviewReport("review-1", {
      email: "user@example.test",
      organizationId: "review_organization_id",
    });

    expect(report).toEqual(
      expect.objectContaining({
        id: "review-1",
        result: { summary: "done", findings: [{ path: "src/a.ts" }] },
      }),
    );
  });
});
