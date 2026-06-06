import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listOrganizations: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/auth", () => ({
  assertAuthSecretConfigured: vi.fn(),
  auth: {
    api: {
      getSession: mocks.getSession,
      listOrganizations: mocks.listOrganizations,
    },
  },
}));

const { requireReportSession } = await import("./report-auth");

describe("requireReportSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ "x-test": "1" }));
    mocks.listOrganizations.mockResolvedValue([{ id: "org-123" }]);
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it("redirects unauthenticated report requests before returning a session", async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    await expect(requireReportSession("/reports/review-1")).rejects.toThrow(
      "redirect:/login?next=%2Freports%2Freview-1",
    );

    expect(mocks.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
    });
    expect(mocks.redirect).toHaveBeenCalledWith("/login?next=%2Freports%2Freview-1");
  });

  it("returns authenticated report sessions", async () => {
    const session = {
      user: { email: "user@example.test" },
      session: { activeOrganizationId: "org-123" },
    };
    mocks.getSession.mockResolvedValueOnce(session);

    await expect(requireReportSession("/reports")).resolves.toEqual({
      email: "user@example.test",
      organizationId: "org-123",
    });

    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects when the active organization is not a verified membership", async () => {
    mocks.getSession.mockResolvedValueOnce({
      user: { email: "user@example.test" },
      session: { activeOrganizationId: "org-123" },
    });
    mocks.listOrganizations.mockResolvedValueOnce([{ id: "org-other" }]);

    await expect(requireReportSession("/reports")).rejects.toThrow("redirect:/reports");
  });
});
