import { beforeEach, describe, expect, mock, test } from "bun:test";

let sentInput: Record<string, unknown> | undefined;

mock.module("@/lib/email-verification", () => ({
  normalizeVerificationEmail: (value: string) => value.trim().toLowerCase(),
}));

mock.module("@/lib/transactional-email", () => ({
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
    const content = sentInput?.content as Record<string, unknown>;
    expect(content.title).toBe("A trial has started");
    expect(content.action).toEqual({
      label: "Open organization",
      url: "https://postil.dev/orgs/acme",
    });
    expect(content).not.toMatchObject({
      summary: expect.stringMatching(/source code/i),
    });
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
    expect(sentInput?.content).toMatchObject({ title: "The trial has ended" });

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
    expect(sentInput?.content).toMatchObject({ title: "GitHub App removed" });
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
    expect(sentInput?.content).toMatchObject({
      details: expect.arrayContaining([
        { label: "Provider subscription", value: "sub_01test" },
      ]),
    });

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
    expect(sentInput?.content).toMatchObject({
      details: expect.arrayContaining([
        { label: "Category", value: "settlement_stale" },
        { label: "Provider reference", value: "sub_01test" },
      ]),
    });
  });

  test("sends a privacy-safe finding feedback digest without an organization link", async () => {
    await runOperatorAlertJob({
      event: "finding_feedback_digest",
      eventKey: "finding-feedback-digest:2026-08-17",
      orgId: null,
      orgSlug: null,
      accountLogin: null,
      githubOwnerId: null,
      periodStart: "2026-08-17T00:00:00.000Z",
      periodEnd: "2026-08-24T00:00:00.000Z",
      aggregates: [{
        source: "reaction",
        suggestedReasonTag: null,
        reactionContent: "-1",
        model: "example/model",
        kind: "risk",
        severity: "error",
        count: 2,
      }],
    });

    expect(sentInput).toMatchObject({
      subject: "Postil finding feedback digest: 2026-08-17",
      content: {
        title: "Finding feedback digest",
        details: [{
          label: "reaction · -1 · example/model · risk · error",
          value: "2",
        }],
      },
    });
    expect(sentInput?.content).not.toHaveProperty("action");
    expect(JSON.stringify(sentInput?.content)).not.toContain("pull-request-author");
    expect(JSON.stringify(sentInput?.content)).not.toContain("reply body");
  });

  test("renders every admitted feedback aggregate with labels bounded for email", async () => {
    const aggregates = Array.from({ length: 20 }, (_, index) => ({
      source: "reaction" as const,
      suggestedReasonTag: null,
      reactionContent: "+1" as const,
      model: `model-${index}-${"m".repeat(490)}`,
      kind: `kind-${"k".repeat(90)}`,
      severity: "warning",
      count: index + 1,
    }));
    await runOperatorAlertJob({
      event: "finding_feedback_digest",
      eventKey: "finding-feedback-digest:2026-08-17",
      orgId: null,
      orgSlug: null,
      accountLogin: null,
      githubOwnerId: null,
      periodStart: "2026-08-17T00:00:00.000Z",
      periodEnd: "2026-08-24T00:00:00.000Z",
      aggregates,
    });

    const details = (sentInput?.content as { details: Array<{ label: string; value: string }> }).details;
    expect(details).toHaveLength(20);
    expect(details.every((detail) => detail.label.length <= 120)).toBe(true);
    expect(details.map((detail) => detail.value)).toEqual(aggregates.map((aggregate) => String(aggregate.count)));
  });
});
