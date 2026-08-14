import { describe, expect, test } from "bun:test";

import {
  membershipRefreshDisposition,
  MEMBERSHIP_RECHECK_INTERVAL_MS,
  waitForUserMembershipRefresh,
} from "@/lib/membership-authority";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const RETRY_AVAILABLE_AT = new Date(NOW + 30_000);

describe("user membership refresh authority", () => {
  test("fails fast during retry backoff without treating it as an active owner", () => {
    expect(
      membershipRefreshDisposition(
        {
          checkedAt: new Date(NOW - MEMBERSHIP_RECHECK_INTERVAL_MS - 1),
          leaseUntil: null,
          retryAfter: RETRY_AVAILABLE_AT,
        },
        false,
        NOW,
      ),
    ).toEqual({ status: "backoff", retryAvailableAt: RETRY_AVAILABLE_AT });
  });

  test("waits only while a refresh owner holds an unexpired lease", () => {
    expect(
      membershipRefreshDisposition(
        {
          checkedAt: null,
          leaseUntil: RETRY_AVAILABLE_AT,
          retryAfter: null,
        },
        false,
        NOW,
      ),
    ).toEqual({ status: "waiting", retryAvailableAt: RETRY_AVAILABLE_AT });
  });

  test("makes an expired lease available for a new generation", () => {
    expect(
      membershipRefreshDisposition(
        {
          checkedAt: null,
          leaseUntil: new Date(NOW),
          retryAfter: null,
        },
        false,
        NOW,
      ),
    ).toEqual({ status: "available" });
  });

  test("accepts shared user freshness for ordinary session verification", () => {
    const checkedAt = new Date(NOW - 1_000);
    expect(
      membershipRefreshDisposition(
        { checkedAt, leaseUntil: null, retryAfter: null },
        false,
        NOW,
      ),
    ).toEqual({ status: "fresh", checkedAt });
    expect(
      membershipRefreshDisposition(
        { checkedAt, leaseUntil: null, retryAfter: null },
        true,
        NOW,
      ),
    ).toEqual({ status: "available" });
  });

  test("coordinates a 30-second follower with bounded database reads", async () => {
    let now = NOW;
    let queryCount = 0;
    const delays: number[] = [];
    const refreshCompletedAt = NOW + 30_000;
    const db = {
      select() {
        queryCount += 1;
        return query;
      },
    } as never;
    const query = {
      from() {
        return query;
      },
      where() {
        return query;
      },
      limit() {
        return Promise.resolve([
          now >= refreshCompletedAt
            ? {
                checkedAt: new Date(refreshCompletedAt),
                leaseUntil: null,
                retryAfter: null,
              }
            : {
                checkedAt: null,
                leaseUntil: new Date(NOW + 60_000),
                retryAfter: null,
              },
        ]);
      },
    };

    const result = await waitForUserMembershipRefresh(db, 7, false, {
      now: () => now,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        now += delayMs;
      },
    });

    expect(result).toEqual({
      status: "fresh",
      checkedAt: new Date(refreshCompletedAt),
    });
    expect(now).toBeGreaterThanOrEqual(refreshCompletedAt);
    expect(queryCount).toBeLessThanOrEqual(20);
    expect(delays.length).toBe(queryCount);
    expect(Math.max(...delays)).toBe(2_000);
  });
});
