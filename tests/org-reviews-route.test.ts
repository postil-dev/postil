import { beforeEach, describe, expect, mock, test } from "bun:test";

let accessState: unknown;
let reviewRows: unknown[];
let requestedLimit: number | undefined;

mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () => accessState,
}));

mock.module("@/lib/org-reviews", () => ({
  getOrgReviewRows: async (_db: unknown, _orgId: number, limit: number) => {
    requestedLimit = limit;
    return reviewRows;
  },
}));

const { GET } = await import("@/app/api/orgs/[slug]/reviews/route");

beforeEach(() => {
  accessState = { ok: true, db: {}, org: { id: 7 } };
  reviewRows = [{ id: 1 }];
  requestedLimit = undefined;
});

describe("GET organization reviews", () => {
  test("returns a retryable JSON error during membership verification outages", async () => {
    accessState = {
      ok: false,
      reason: "verification_unavailable",
      retryAvailableAt: new Date(Date.now() + 60_000),
    };

    const response = await invoke();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({
      error: "membership verification unavailable",
    });
    expect(requestedLimit).toBeUndefined();
  });

  test("keeps unauthenticated and cross-tenant failures distinct", async () => {
    accessState = { ok: false, reason: "unauthenticated" };
    expect((await invoke()).status).toBe(401);

    accessState = { ok: false, reason: "not_found" };
    expect((await invoke()).status).toBe(404);
  });

  test("returns review JSON with a bounded limit after verified access", async () => {
    const response = await invoke("500");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(reviewRows);
    expect(requestedLimit).toBe(50);
  });
});

function invoke(limit?: string): Promise<Response> {
  const url = new URL("https://postil.dev/api/orgs/acme/reviews");
  if (limit) url.searchParams.set("limit", limit);
  return GET(new Request(url), { params: Promise.resolve({ slug: "acme" }) });
}
