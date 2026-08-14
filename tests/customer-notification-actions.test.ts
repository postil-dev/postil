import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  membershipRetryDelayFromDigest,
  MembershipVerificationUnavailableError,
} from "@/lib/auth-navigation";

let accessRole = "member";
let visibleRows: Array<{ id: number }> = [{ id: 9 }];
let inserted: Record<string, unknown> | null = null;
let executeCount = 0;
let revalidated: string[] = [];
let verificationRetryAvailableAt: Date | undefined;

const schema = {
  customerNotificationEvents: {
    id: "customer_notification_events.id",
    orgId: "customer_notification_events.org_id",
    expiresAt: "customer_notification_events.expires_at",
    visibility: "customer_notification_events.visibility",
  },
  customerNotificationReads: {
    id: "customer_notification_reads.id",
    eventId: "customer_notification_reads.event_id",
    userId: "customer_notification_reads.user_id",
  },
};

mock.module("@/lib/db", () => ({ schema }));
mock.module("next/cache", () => ({
  revalidatePath: (path: string) => revalidated.push(path),
}));
mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () =>
    verificationRetryAvailableAt
      ? {
          ok: false,
          reason: "verification_unavailable",
          retryAvailableAt: verificationRetryAvailableAt,
        }
      : {
          ok: true,
          db: fakeDb(),
          user: { id: 7 },
          org: { id: 20 },
          membership: { id: 1, role: accessRole },
        },
}));

const { markAllNotificationsRead, markNotificationRead } = await import(
  "@/app/orgs/[slug]/notifications/actions"
);

beforeEach(() => {
  accessRole = "member";
  visibleRows = [{ id: 9 }];
  inserted = null;
  executeCount = 0;
  revalidated = [];
  verificationRetryAvailableAt = undefined;
});

describe("customer notification actions", () => {
  test("marks one visible event read without changing its first read time", async () => {
    const form = new FormData();
    form.set("slug", "acme");
    form.set("eventId", "9");
    await markNotificationRead(form);

    expect(inserted).toMatchObject({ eventId: 9, userId: 7 });
    expect(revalidated).toEqual(["/orgs/acme", "/orgs/acme/notifications"]);
  });

  test("does not disclose or mark an event outside the member's visible scope", async () => {
    visibleRows = [];
    const form = new FormData();
    form.set("slug", "acme");
    form.set("eventId", "10");
    await expect(markNotificationRead(form)).rejects.toThrow("notification not found");
    expect(inserted).toBeNull();
  });

  test("marks every visible unexpired event with one idempotent statement", async () => {
    accessRole = "admin";
    const form = new FormData();
    form.set("slug", "acme");
    await markAllNotificationsRead(form);

    expect(executeCount).toBe(1);
    expect(revalidated).toEqual(["/orgs/acme", "/orgs/acme/notifications"]);
  });

  test("preserves retry timing when membership verification blocks a server action", async () => {
    verificationRetryAvailableAt = new Date(Date.now() + 60_000);
    const form = new FormData();
    form.set("slug", "acme");
    form.set("eventId", "9");

    let rejected: unknown;
    try {
      await markNotificationRead(form);
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(MembershipVerificationUnavailableError);
    const retryDelayMs = membershipRetryDelayFromDigest(
      (rejected as MembershipVerificationUnavailableError).digest,
    );
    expect(retryDelayMs).toBeGreaterThanOrEqual(59_000);
    expect(retryDelayMs).toBeLessThanOrEqual(60_000);
    expect(inserted).toBeNull();
  });

  test("keeps member and administrator visibility checks in both actions", async () => {
    const source = await readFile(
      new URL("../src/app/orgs/[slug]/notifications/actions.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("event.visibility = 'members'");
    expect(source).toContain("event.visibility IN ('members', 'admins')");
    expect(source).toContain("ON CONFLICT (event_id, user_id) DO NOTHING");
  });
});

function fakeDb() {
  return {
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => visibleRows,
      };
      return chain;
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted = values;
        return { onConflictDoNothing: async () => [] };
      },
    }),
    execute: async () => {
      executeCount += 1;
      return { rowCount: 1 };
    },
  };
}
