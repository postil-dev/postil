import { beforeEach, describe, expect, mock, test } from "bun:test";

let sentInput: Record<string, unknown> | undefined;

mock.module("@/lib/email-verification", () => ({
  normalizeVerificationEmail: (value: string) => value.trim().toLowerCase(),
  sendTransactionalEmail: async (input: Record<string, unknown>) => {
    sentInput = input;
    return { messageId: "brevo-message-operator-1" };
  },
}));

const { runOperatorAlertJob } = await import("@/worker/operator-alert");

describe("operator alert job", () => {
  beforeEach(() => {
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.com";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.BREVO_API_KEY = "brevo-key";
    sentInput = undefined;
  });

  test("sends one idempotent trial-start alert without repository content", async () => {
    const result = await runOperatorAlertJob({
      event: "trial_started",
      eventKey: "trial-started:700",
      orgId: 7,
      orgSlug: "acme",
      accountLogin: "Acme",
      accountType: "Organization",
      githubOwnerId: 700,
      githubInstallationId: 701,
      trialEndsAt: "2026-08-17T12:00:00.000Z",
    });

    expect(sentInput).toMatchObject({
      recipient: "operator@example.com",
      subject: "New Postil trial: Acme",
      apiKey: "brevo-key",
    });
    expect(sentInput?.idempotencyKey).toMatch(/^postil-operator-[0-9a-f]{64}$/);
    expect(result).toEqual({ messageId: "brevo-message-operator-1" });
    const text = (sentInput?.text as string[]).join("\n");
    expect(text).toContain("A GitHub owner started a 30-day Postil trial.");
    expect(text).toContain("Dashboard: https://postil.dev/orgs/acme");
    expect(text).not.toMatch(/repository|pull request|source code/i);
  });

  test("sends concise expiry and uninstall alerts with stable idempotency", async () => {
    await runOperatorAlertJob({
      event: "trial_expired",
      eventKey: "trial-expired:7:2026-08-17T12:00:00.000Z",
      orgId: 7,
      orgSlug: "acme",
      accountLogin: "Acme",
      githubOwnerId: 700,
      trialEndsAt: "2026-08-17T12:00:00.000Z",
    });
    expect(sentInput).toMatchObject({
      subject: "Postil trial ended: Acme",
    });
    expect((sentInput?.text as string[]).join("\n")).toContain(
      "A Postil trial ended without an active plan.",
    );

    await runOperatorAlertJob({
      event: "installation_removed",
      eventKey: "installation-removed:701",
      orgId: 7,
      orgSlug: "acme",
      accountLogin: "Acme",
      accountType: "Organization",
      githubOwnerId: 700,
      githubInstallationId: 701,
    });
    expect(sentInput).toMatchObject({
      subject: "Postil App removed: Acme",
    });
    const text = (sentInput?.text as string[]).join("\n");
    expect(text).toContain("A GitHub owner removed the Postil App.");
    expect(text).not.toMatch(/repository|pull request|source code/i);
  });

  test("rejects malformed payloads before sending", async () => {
    await expect(
      runOperatorAlertJob({
        event: "trial_started",
        eventKey: "trial-started:700",
        orgId: 7,
        orgSlug: "bad\nslug",
        accountLogin: "Acme",
        accountType: "Organization",
        githubOwnerId: 700,
        githubInstallationId: 701,
        trialEndsAt: "2026-08-17T12:00:00.000Z",
      }),
    ).rejects.toThrow("operator alert job payload is malformed");
    expect(sentInput).toBeUndefined();
  });

  test("sends concise subscription lifecycle and anomaly alerts", async () => {
    const base = {
      orgId: 7,
      orgSlug: "acme",
      accountLogin: "Acme",
      githubOwnerId: 700,
      providerSubscriptionId: "sub_01test",
    };
    await runOperatorAlertJob({
      ...base,
      event: "subscription_started",
      eventKey: "subscription-started:sub_01test:evt_1",
      periodEndsAt: "2026-09-18T00:00:00.000Z",
    });
    expect(sentInput).toMatchObject({
      subject: "Postil subscription active: Acme",
    });

    await runOperatorAlertJob({
      ...base,
      event: "subscription_past_due",
      eventKey: "subscription-past-due:sub_01test:evt_2",
      periodEndsAt: null,
    });
    expect(sentInput).toMatchObject({
      subject: "Postil payment past due: Acme",
    });
    expect((sentInput?.text as string[]).join("\n")).toContain(
      "Provider subscription: sub_01test",
    );

    await runOperatorAlertJob({
      orgId: base.orgId,
      orgSlug: base.orgSlug,
      accountLogin: base.accountLogin,
      githubOwnerId: base.githubOwnerId,
      event: "billing_anomaly",
      eventKey: "billing-anomaly:settlement-1:settlement_stale",
      providerObjectId: base.providerSubscriptionId,
      category: "settlement_stale",
    });
    expect(sentInput).toMatchObject({
      subject: "Postil billing needs attention: Acme",
    });
    expect((sentInput?.text as string[]).join("\n")).toContain(
      "Category: settlement_stale",
    );
    expect((sentInput?.text as string[]).join("\n")).toContain(
      "Provider reference: sub_01test",
    );
  });
});
