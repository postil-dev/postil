import { describe, expect, test } from "bun:test";

import {
  boundedRetryAfterDelayMs,
  boundedRetryDelayMs,
  membershipRetryAfterHeader,
  scheduleRetryAfter,
} from "@/lib/auth-navigation";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

describe("membership Retry-After", () => {
  test("serializes the exact bounded membership retry window", () => {
    expect(membershipRetryAfterHeader(new Date(NOW + 47_001), NOW)).toBe("48");
    expect(membershipRetryAfterHeader(new Date(NOW - 1), NOW)).toBe("1");
    expect(membershipRetryAfterHeader(new Date(NOW + 86_400_000), NOW)).toBe(
      "3600",
    );
  });

  test("parses delta-seconds and HTTP dates with bounded fallbacks", () => {
    expect(
      boundedRetryAfterDelayMs(new Headers({ "retry-after": "900" }), 2_000, NOW),
    ).toBe(900_000);
    expect(
      boundedRetryAfterDelayMs(
        new Headers({ "retry-after": new Date(NOW + 45_000).toUTCString() }),
        2_000,
        NOW,
      ),
    ).toBe(45_000);
    expect(
      boundedRetryAfterDelayMs(new Headers({ "retry-after": "invalid" }), 5_000, NOW),
    ).toBe(5_000);
    expect(
      boundedRetryAfterDelayMs(new Headers({ "retry-after": "86400" }), 2_000, NOW),
    ).toBe(3_600_000);
    expect(boundedRetryDelayMs(Number.POSITIVE_INFINITY, 5_000)).toBe(
      3_600_000,
    );
  });

  test("does not fire a scheduled poll before the provider retry window", () => {
    const timer = new FakeTimer();
    let polls = 0;
    scheduleRetryAfter(
      new Headers({ "retry-after": "900" }),
      () => {
        polls += 1;
      },
      2_000,
      timer.schedule,
      NOW,
    );

    timer.advanceBy(899_999);
    expect(polls).toBe(0);
    timer.advanceBy(1);
    expect(polls).toBe(1);
  });
});

class FakeTimer {
  private now = 0;
  private pending: Array<{ at: number; callback: () => void }> = [];

  readonly schedule = (callback: () => void, delayMs: number): number => {
    this.pending.push({ at: this.now + delayMs, callback });
    return this.pending.length;
  };

  advanceBy(delayMs: number): void {
    this.now += delayMs;
    const ready = this.pending.filter((timer) => timer.at <= this.now);
    this.pending = this.pending.filter((timer) => timer.at > this.now);
    for (const timer of ready) timer.callback();
  }
}
