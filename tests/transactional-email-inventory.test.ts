import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { productionMonitorEmailContent } from "@/../scripts/send-production-monitor-alert";
import { billingContactVerificationEmailContent } from "@/lib/billing-contact-verification";
import { customerNotificationSummaryEmailContent } from "@/lib/customer-notification-email";
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
      customerNotificationSummaryEmailContent({
        orgName: "Acme",
        orgSlug: "acme",
        emailCategory: "billing_summary",
        events: [{
          id: 1,
          idempotencyKey: "subscription-restored:sub_preview:event_preview",
          severity: "info",
          title: "Your subscription is active",
          body: "Private-repository reviews are available under your subscription.",
        }],
        publicOrigin: "https://postil.dev",
      }).content,
      ...operatorPayloads.map(
        (payload) =>
          operatorAlertEmailContent(
            payload,
            payload.orgSlug
              ? `https://postil.dev/orgs/${payload.orgSlug}`
              : null,
          ).content,
      ),
      productionMonitorEmailContent(
        "failure",
        "c5bb3ebbff986e2c93184daa38551ec26d4b06ee",
        "https://github.com/postil-dev/postil/actions/runs/29654572437",
      ),
      productionMonitorEmailContent(
        "test",
        "c5bb3ebbff986e2c93184daa38551ec26d4b06ee",
        "https://github.com/postil-dev/postil/actions/runs/29654572437",
      ),
      privateMonitoringIncidentEmailContent(
        {
          incidentKey: "worker-heartbeat",
          kind: "opened",
          capability: "fleet",
          severity: "critical",
          summary: "Review worker heartbeat is stale",
          detail: "No recent worker heartbeat has been recorded.",
          firstObservedAt: new Date("2026-07-20T12:00:00.000Z"),
          lastObservedAt: new Date("2026-07-20T12:05:00.000Z"),
          resolvedAt: null,
        },
        "https://postil.dev/operator#monitoring",
      ),
      privateMonitoringIncidentEmailContent(
        {
          incidentKey: "billing-settlement-delay",
          kind: "reminder",
          capability: "billing",
          severity: "warning",
          summary: "Billing reconciliation needs attention",
          detail: "The incident remains open.",
          firstObservedAt: new Date("2026-07-20T06:00:00.000Z"),
          lastObservedAt: new Date("2026-07-20T12:05:00.000Z"),
          resolvedAt: null,
        },
        "https://postil.dev/operator#monitoring",
      ),
      privateMonitoringIncidentEmailContent(
        {
          incidentKey: "worker-heartbeat",
          kind: "resolved",
          capability: "fleet",
          severity: "critical",
          summary: "Review worker fleet recovered",
          detail: "The worker heartbeat is fresh.",
          firstObservedAt: new Date("2026-07-20T12:00:00.000Z"),
          lastObservedAt: new Date("2026-07-20T12:05:00.000Z"),
          resolvedAt: new Date("2026-07-20T12:10:00.000Z"),
        },
        "https://postil.dev/operator#monitoring",
      ),
      privateMonitoringPassFailureEmailContent("https://postil.dev"),
    ];

    expect(content).toHaveLength(17);
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

  test("routes every production sender through the Brevo HTTPS transport", () => {
    const files = [...sourceFiles("src"), ...sourceFiles("scripts")].filter(
      (path) => !path.startsWith("src/data/evidence/"),
    );
    const sources = new Map(
      files.map((path) => [path, readFileSync(path, "utf8")]),
    );
    const brevoEndpointOwners = [...sources]
      .filter(([, source]) => source.includes("https://api.brevo.com"))
      .map(([path]) => path);
    expect(brevoEndpointOwners).toEqual(["src/lib/transactional-email.ts"]);

    const directSenders = [...sources]
      .filter(
        ([path, source]) =>
          path !== "src/lib/transactional-email.ts" &&
          /\bsendTransactionalEmail\s*\(/.test(source),
      )
      .map(([path]) => path)
      .sort();
    expect(directSenders).toEqual([
      "scripts/send-production-monitor-alert.ts",
      "src/lib/customer-notification-email.ts",
      "src/lib/email-verification.ts",
      "src/lib/operator-notifications.ts",
    ]);

    const forbiddenTransport =
      /\b(?:nodemailer|createTransport|SMTP_(?:HOST|PORT|USER|PASS)|smtp:\/\/|smtps:\/\/|api\.mailgun\.|api\.postmarkapp\.|api\.resend\.)/i;
    const violations = [...sources]
      .filter(([, source]) => forbiddenTransport.test(source))
      .map(([path]) => path);
    expect(violations).toEqual([]);

    const packageManifest = readFileSync("package.json", "utf8");
    expect(packageManifest).not.toMatch(
      /\b(?:nodemailer|smtp-client|emailjs|mailgun|postmark|resend)\b/i,
    );
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
