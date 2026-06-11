import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = { METRICS_API_KEY: "test-metrics-key" };
vi.mock("@/lib/env", () => ({
  env: mockEnv,
}));

const mockSelect = vi.fn();

vi.mock("@/db", () => ({
  getDb: () => ({
    select: mockSelect,
  }),
  schema: {
    reviews: {
      status: "status",
      createdAt: "createdAt",
      completedAt: "completedAt",
      id: "id",
      repoFullName: "repoFullName",
      pullNumber: "pullNumber",
      errorMessage: "errorMessage",
    },
    usageEvents: { createdAt: "createdAt", kind: "kind", quantity: "quantity" },
  },
}));

const { GET } = await import("./route");

describe("metrics endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.METRICS_API_KEY = "test-metrics-key";
  });

  function makeRequest(path = "/api/metrics?days=7", key = "test-metrics-key") {
    return new Request(`http://localhost${path}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
  }

  it("rejects requests without auth header", async () => {
    const res = await GET(makeRequest("/api/metrics", ""));
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong key", async () => {
    const res = await GET(makeRequest("/api/metrics", "wrong-key"));
    expect(res.status).toBe(401);
  });

  it("rejects requests when metrics auth is unset", async () => {
    mockEnv.METRICS_API_KEY = undefined;
    const res = await GET(makeRequest("/api/metrics", "test-metrics-key"));
    expect(res.status).toBe(401);
  });

  it("returns metrics for authenticated requests", async () => {
    // Chain: select().from().where().groupBy() => reviewStats
    const groupByResult = [{ status: "completed", count: 5 }];
    const groupBy = vi.fn().mockResolvedValue(groupByResult);
    const where2 = vi.fn().mockReturnValue({ groupBy });
    const _from2 = vi.fn().mockReturnValue({ where: where2 });

    // Chain: select().from().where().groupBy() => reviewStats
    // select().from().where(and()) => durationRow
    // select().from().where(and()) => tokenStats
    // select().from().where(and()) => reviewEvents
    // select().from().where(and()) => staleRunningReviews
    // select().from().where(and()).orderBy().limit() => recentFailures
    let callCount = 0;
    mockSelect.mockImplementation(() => ({
      from: () => ({
        where: (_arg: unknown) => {
          callCount++;
          if (callCount === 1) {
            // review stats — has groupBy
            return { groupBy: async () => [{ status: "completed", count: 5 }] };
          }
          if (callCount === 2) {
            // duration — single row
            return [{ avgMs: 3200 }];
          }
          if (callCount === 3) {
            // token stats — single row
            return [{ totalTokens: 12000, eventCount: 5 }];
          }
          if (callCount === 4) {
            // review events — single row
            return [{ count: 5 }];
          }
          if (callCount === 5) {
            // stale running reviews — single row
            return [{ count: 1 }];
          }
          // recent failures
          return {
            orderBy: () => ({
              limit: () => [
                {
                  id: "failure-1",
                  repoFullName: "acme/widget",
                  pullNumber: 99,
                  status: "failed",
                  errorMessage: "Review timed out before completion.",
                  createdAt: new Date("2026-06-01T10:00:00Z"),
                },
              ],
            }),
          };
        },
      }),
    }));

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window.days).toBe(7);
    expect(body.reviews.total).toBe(5);
    expect(body.reviews.byStatus.completed).toBe(5);
    expect(body.reviews.successRatePct).toBe(100);
    expect(body.reviews.staleRunning).toEqual({ olderThanMinutes: 30, count: 1 });
    expect(body.recentFailures[0]).toMatchObject({
      id: "failure-1",
      failureClass: "timeout",
    });
    expect(body.usage.totalTokens).toBe(12000);
  });
});
