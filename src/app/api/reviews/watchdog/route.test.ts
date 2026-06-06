import { beforeEach, describe, expect, it, vi } from "vitest";

const watchdogMock = vi.hoisted(() => ({
  completeStaleReviewCheckRuns: vi.fn(async () => ({
    scanned: 1,
    completed: 1,
    failed: 0,
    cutoff: "2026-06-06T09:00:00.000Z",
  })),
}));

const envMock = vi.hoisted(() => ({
  METRICS_API_KEY: "test-metrics-key" as string | undefined,
}));

vi.mock("@/lib/env", () => ({
  env: envMock,
}));

vi.mock("@/jobs/review-watchdog", () => watchdogMock);

const { POST } = await import("./route");

describe("review watchdog endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.METRICS_API_KEY = "test-metrics-key";
  });

  function request(key = "test-metrics-key") {
    return new Request("http://localhost/api/reviews/watchdog", {
      method: "POST",
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
  }

  it("rejects missing auth", async () => {
    const res = await POST(request(""));
    expect(res.status).toBe(401);
    expect(watchdogMock.completeStaleReviewCheckRuns).not.toHaveBeenCalled();
  });

  it("fails closed when auth is not configured", async () => {
    envMock.METRICS_API_KEY = undefined;

    const res = await POST(request(""));

    expect(res.status).toBe(503);
    expect(watchdogMock.completeStaleReviewCheckRuns).not.toHaveBeenCalled();
  });

  it("runs the watchdog for authenticated operators", async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      scanned: 1,
      completed: 1,
      failed: 0,
    });
  });
});
