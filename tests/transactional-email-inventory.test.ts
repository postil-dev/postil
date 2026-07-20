import { describe, expect, test } from "bun:test";

import { billingContactVerificationEmailContent } from "@/lib/billing-contact-verification";
import { operatorAlertEmailContent } from "@/lib/operator-alert-email";
import type { OperatorAlertJobPayload } from "@/lib/operator-alerts";
import {
  privateMonitoringIncidentEmailContent,
  privateMonitoringPassFailureEmailContent,
} from "@/lib/private-monitoring";
import {
  assertApplicationEmailBody,
  renderTransactionalEmail,
  type TransactionalEmailContent,
} from "@/lib/transactional-email";

const base = {
  orgId: 7,
  orgSlug: "acme",
  accountLogin: "Acme",
  githubOwnerId: 700,
};

const operatorPayloads: OperatorAlertJobPayload[] = [
  {
    ...base,
    event: "trial_started",
    eventKey: "trial-started:700",
    accountType: "Organization",
    githubInstallationId: 701,
    trialEndsAt: "2026-08-18T12:00:00.000Z",
  },
  {
    ...base,
    event: "trial_expired",
    eventKey: "trial-expired:7:2026-08-18T12:00:00.000Z",
    trialEndsAt: "2026-08-18T12:00:00.000Z",
  },
  {
    ...base,
    event: "installation_removed",
    eventKey: "installation-removed:701",
    accountType: "Organization",
    githubInstallationId: 701,
  },
  ...(
    [
      "subscription_started",
      "subscription_past_due",
      "subscription_paused",
      "subscription_canceled",
    ] as const
  ).map((event): OperatorAlertJobPayload => ({
    ...base,
    event,
    eventKey: `${event}:sub_preview:event_preview`,
    providerSubscriptionId: "sub_preview",
    periodEndsAt:
      event === "subscription_started" ? "2026-09-18T00:00:00.000Z" : null,
  })),
  {
    ...base,
    event: "billing_anomaly",
    eventKey: "billing-anomaly:sub_preview:settlement_failed",
    providerObjectId: "sub_preview",
    category: "settlement_failed",
  },
  {
    event: "billing_anomaly",
    eventKey: "billing-anomaly:event_preview:unmatched_provider_event",
    orgId: null,
    orgSlug: null,
    accountLogin: null,
    githubOwnerId: null,
    providerObjectId: "event_preview",
    category: "unmatched_provider_event",
  },
];

describe("outbound email inventory", () => {
  test("covers every production content type with context, next step, and text fallback", () => {
    const content: TransactionalEmailContent[] = [
      billingContactVerificationEmailContent(
        "Acme",
        "https://postil.dev/verify/billing-contact?org=7&token=not-a-secret%3Apreview-layout-only%3Athis-value-has-no-authority",
      ),
      ...operatorPayloads.map(
        (payload) =>
          operatorAlertEmailContent(
            payload,
            payload.orgSlug
              ? `https://postil.dev/orgs/${payload.orgSlug}`
              : null,
          ).content,
      ),
      privateMonitoringIncidentEmailContent(
        {
          kind: "opened",
          severity: "critical",
          summary: "Review worker heartbeat is stale",
          detail: "No recent worker heartbeat has been recorded.",
        },
        "https://postil.dev/operator#monitoring",
      ),
      privateMonitoringIncidentEmailContent(
        {
          kind: "reminder",
          severity: "warning",
          summary: "Billing reconciliation needs attention",
          detail: "The incident remains open.",
        },
        "https://postil.dev/operator#monitoring",
      ),
      privateMonitoringIncidentEmailContent(
        {
          kind: "resolved",
          severity: "critical",
          summary: "Review worker heartbeat recovered",
          detail: "The worker heartbeat is fresh.",
        },
        "https://postil.dev/operator#monitoring",
      ),
      privateMonitoringPassFailureEmailContent("https://postil.dev"),
    ];

    expect(content).toHaveLength(14);
    for (const message of content) {
      expect(message.title.length).toBeGreaterThan(5);
      expect(message.summary.length).toBeGreaterThan(10);
      expect(message.reason.length).toBeGreaterThan(10);
      expect(Boolean(message.action || message.note)).toBe(true);

      const rendered = renderTransactionalEmail(message);
      assertApplicationEmailBody(rendered.html, message.action?.url);
      expect(rendered.text).toContain(message.title);
      expect(rendered.text).toContain("Why you received this:");
    }
  });
});
