import { describe, expect, test } from "bun:test";

import {
  CUSTOMER_NOTIFICATION_RETENTION_MS,
  enqueueCustomerNotification,
  installationRemovedNotification,
  installationRestoredNotification,
  installationSuspendedNotification,
  pruneExpiredCustomerNotifications,
  serviceDisruptionNotification,
  serviceRecoveryNotification,
  settlementFailedNotification,
  subscriptionCanceledNotification,
  subscriptionPausedNotification,
  subscriptionPastDueNotification,
  subscriptionRestoredNotification,
  trialExpiredNotification,
  trialStartedNotification,
  validateCustomerNotification,
} from "@/lib/customer-notifications";

describe("customer notifications", () => {
  test("stores one bounded event with a stable organization key and expiry", async () => {
    let stored: Record<string, unknown> | null = null;
    let conflictTarget: unknown = null;
    const db = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          stored = values;
          return {
            onConflictDoNothing: (input: { target: unknown }) => {
              conflictTarget = input.target;
              return { returning: async () => [{ id: 1 }] };
            },
          };
        },
      }),
    };
    const now = new Date("2026-07-20T12:00:00.000Z");

    const created = await enqueueCustomerNotification(
      db as never,
      trialStartedNotification({ orgId: 7, orgSlug: "acme", githubOwnerId: 70 }),
      now,
    );

    expect(created).toBe(true);
    expect(stored).toMatchObject({
      orgId: 7,
      idempotencyKey: "trial-started:70",
      visibility: "members",
      actionHref: "/orgs/acme",
      createdAt: now,
      expiresAt: new Date(now.getTime() + CUSTOMER_NOTIFICATION_RETENTION_MS),
    });
    expect(conflictTarget).toHaveLength(2);
  });

  test("keeps customer copy actionable without internal provider details", () => {
    const trialExpired = trialExpiredNotification({
      orgId: 7,
      orgSlug: "acme",
      trialEndsAt: new Date("2026-08-19T12:00:00.000Z"),
    });
    const pastDue = subscriptionPastDueNotification({
      orgId: 7,
      orgSlug: "acme",
      providerSubscriptionId: "sub_1",
      eventId: "evt_1",
    });
    const settlementFailed = settlementFailedNotification({
      orgId: 7,
      orgSlug: "acme",
      settlementId: "11111111-1111-4111-8111-111111111111",
    });
    const restored = subscriptionRestoredNotification({
      orgId: 7,
      orgSlug: "acme",
      providerSubscriptionId: "sub_1",
      eventId: "evt_2",
    });
    const paused = subscriptionPausedNotification({
      orgId: 7,
      orgSlug: "acme",
      providerSubscriptionId: "sub_1",
      eventId: "evt_3",
    });
    const canceled = subscriptionCanceledNotification({
      orgId: 7,
      orgSlug: "acme",
      providerSubscriptionId: "sub_1",
      eventId: "evt_4",
    });

    expect(trialExpired).toMatchObject({ category: "trial", visibility: "members" });
    expect(pastDue).toMatchObject({
      category: "billing",
      visibility: "admins",
      actionHref: "/orgs/acme/billing",
    });
    expect(settlementFailed).toMatchObject({
      category: "billing",
      severity: "critical",
      visibility: "admins",
    });
    for (const message of [
      trialExpired,
      pastDue,
      settlementFailed,
      restored,
      paused,
      canceled,
    ]) {
      expect(`${message.title} ${message.body}`).not.toMatch(
        /provider|paddle|model|token|cost|stack|incident|exception/i,
      );
    }
  });

  test("separates account and service transitions by audience", () => {
    const commonInstallation = {
      orgId: 7,
      orgSlug: "acme",
      githubInstallationId: 70,
      sourceEventId: "delivery-1",
    };
    const accountMessages = [
      installationSuspendedNotification(commonInstallation),
      installationRestoredNotification(commonInstallation),
      installationRemovedNotification(commonInstallation),
    ];
    const firstObservedAt = new Date("2026-07-20T12:00:00.000Z");
    const serviceMessages = [
      serviceDisruptionNotification({
        orgId: 7,
        orgSlug: "acme",
        incidentKey: "worker-heartbeat",
        firstObservedAt,
      }),
      serviceRecoveryNotification({
        orgId: 7,
        orgSlug: "acme",
        incidentKey: "worker-heartbeat",
        firstObservedAt,
      }),
    ];

    expect(accountMessages.every((message) =>
      message.category === "security" && message.visibility === "admins"
    )).toBe(true);
    expect(serviceMessages.every((message) =>
      message.category === "service" && message.visibility === "members"
    )).toBe(true);
    expect(serviceMessages.map((message) => message.idempotencyKey)).toEqual([
      "service-disruption:worker-heartbeat:2026-07-20T12:00:00.000Z",
      "service-recovery:worker-heartbeat:2026-07-20T12:00:00.000Z",
    ]);
  });

  test("rejects incomplete, external, or oversized actions", () => {
    const base = trialStartedNotification({ orgId: 7, orgSlug: "acme", githubOwnerId: 70 });
    expect(() => validateCustomerNotification({ ...base, actionHref: undefined })).toThrow(
      "provided together",
    );
    expect(() => validateCustomerNotification({ ...base, actionHref: "https://example.com" })).toThrow(
      "organization path",
    );
    expect(() => validateCustomerNotification({ ...base, actionHref: "/orgs/other/billing" })).toThrow(
      "organization path",
    );
    expect(() => validateCustomerNotification({ ...base, title: "x".repeat(121) })).toThrow(
      "title must be 1..120",
    );
  });

  test("prunes in bounded batches", async () => {
    let executed = 0;
    const db = { execute: async () => { executed += 1; return { rowCount: 12 }; } };
    expect(await pruneExpiredCustomerNotifications(db as never, new Date(), 25)).toBe(12);
    expect(executed).toBe(1);
    await expect(pruneExpiredCustomerNotifications(db as never, new Date(), 0)).rejects.toThrow(
      "1..10000",
    );
  });
});
