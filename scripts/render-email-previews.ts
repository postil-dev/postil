import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

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
} from "@/lib/transactional-email";

const outputDirectory = resolve(
  process.argv[2] ?? "/tmp/postil-email-previews",
);
rmSync(outputDirectory, { force: true, recursive: true });
mkdirSync(outputDirectory, { recursive: true });

const verification = {
  ...billingContactVerificationEmailContent(
    "Acme",
    "https://postil.dev/verify/billing-contact?org=7&token=not-a-secret%3Apreview-layout-only%3Athis-value-has-no-authority",
  ),
  note: "This link expires in 24 hours. If you did not request this change, you can ignore this email.",
};

const operatorBase = {
  orgId: 7,
  orgSlug: "acme",
  accountLogin: "Acme",
  githubOwnerId: 700,
} as const;
const subscriptionBase = {
  ...operatorBase,
  providerSubscriptionId: "sub_preview",
  periodEndsAt: null,
} as const;

const previews = [
  ["verification", verification],
  customerPreview("customer-billing-summary", "billing_summary", [
    {
      id: 1,
      idempotencyKey: "subscription-restored:sub_preview:event_preview",
      severity: "info",
      title: "Your subscription is active",
      body: "Private-repository reviews are available.",
    },
  ]),
  customerPreview("customer-payment-failure", "payment_failure", [
    {
      id: 2,
      idempotencyKey: "subscription-past-due:sub_preview:event_preview",
      severity: "critical",
      title: "Payment needs attention",
      body: "Update billing details to keep private-repository reviews available.",
    },
  ]),
  customerPreview("customer-security", "security", [
    {
      id: 3,
      idempotencyKey: "installation-suspended:701:event_preview",
      severity: "warning",
      title: "GitHub App access is suspended",
      body: "Reviews are paused until access is restored.",
    },
  ]),
  customerPreview("customer-trial-expiry", "trial_expiry", [
    {
      id: 4,
      idempotencyKey: "trial-expired:7:2026-08-18T12:00:00.000Z",
      severity: "warning",
      title: "Your trial has ended",
      body: "Choose a plan to continue private-repository reviews.",
    },
  ]),
  customerPreview("customer-service-incident", "service_incident", [
    {
      id: 5,
      idempotencyKey: "service-disruption:worker:2026-07-20T12:00:00.000Z",
      severity: "critical",
      title: "Hosted reviews are delayed",
      body: "Queued reviews may take longer to start.",
    },
  ]),
  customerPreview("customer-service-recovery", "service_incident", [
    {
      id: 6,
      idempotencyKey: "service-recovery:worker:2026-07-20T12:00:00.000Z",
      severity: "info",
      title: "Hosted reviews are running normally",
      body: "Queued reviews can start normally.",
    },
  ]),
  operatorPreview("trial-started", {
    ...operatorBase,
    event: "trial_started",
    eventKey: "trial-started:700",
    accountType: "Organization",
    githubInstallationId: 701,
    trialEndsAt: "2026-08-18T12:00:00.000Z",
  }),
  operatorPreview("trial-expired", {
    ...operatorBase,
    event: "trial_expired",
    eventKey: "trial-expired:7:2026-08-18T12:00:00.000Z",
    trialEndsAt: "2026-08-18T12:00:00.000Z",
  }),
  operatorPreview("installation-removed", {
    ...operatorBase,
    event: "installation_removed",
    eventKey: "installation-removed:701",
    accountType: "Organization",
    githubInstallationId: 701,
  }),
  operatorPreview("subscription-active", {
    ...subscriptionBase,
    event: "subscription_started",
    eventKey: "subscription-started:sub_preview:event_preview",
    periodEndsAt: "2026-09-18T00:00:00.000Z",
  }),
  operatorPreview("subscription-past-due", {
    ...subscriptionBase,
    event: "subscription_past_due",
    eventKey: "subscription-past-due:sub_preview:event_preview",
  }),
  operatorPreview("subscription-paused", {
    ...subscriptionBase,
    event: "subscription_paused",
    eventKey: "subscription-paused:sub_preview:event_preview",
  }),
  operatorPreview("subscription-canceled", {
    ...subscriptionBase,
    event: "subscription_canceled",
    eventKey: "subscription-canceled:sub_preview:event_preview",
  }),
  operatorPreview("billing-anomaly", {
    ...operatorBase,
    event: "billing_anomaly",
    eventKey: "billing-anomaly:sub_preview:settlement_failed",
    providerObjectId: "sub_preview",
    category: "settlement_failed",
  }),
  [
    "billing-anomaly-unmatched",
    operatorAlertEmailContent(
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
      null,
    ).content,
  ],
  [
    "private-monitor-opened",
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
  ],
  [
    "private-monitor-reminder",
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
  ],
  [
    "private-monitor-resolved",
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
  ],
  [
    "private-monitor-unavailable",
    privateMonitoringPassFailureEmailContent("https://postil.dev"),
  ],
  [
    "github-monitor-failure",
    productionMonitorEmailContent(
      "failure",
      "c5bb3ebbff986e2c93184daa38551ec26d4b06ee",
      "https://github.com/postil-dev/postil/actions/runs/29654572437",
    ),
  ],
  [
    "github-monitor-test",
    productionMonitorEmailContent(
      "test",
      "c5bb3ebbff986e2c93184daa38551ec26d4b06ee",
      "https://github.com/postil-dev/postil/actions/runs/29654572437",
    ),
  ],
] as const;

for (const [name, content] of previews) {
  const rendered = renderTransactionalEmail(content);
  assertApplicationEmailBody(rendered.html, content.action?.url);
  await Bun.write(resolve(outputDirectory, `${name}.html`), rendered.html);
  await Bun.write(resolve(outputDirectory, `${name}.txt`), rendered.text);
}

const links = previews
  .map(
    ([name, content]) =>
      `<li><strong>${escapeHtml(name)}</strong><a href="./${name}.html">HTML · ${escapeHtml(content.category)} · ${escapeHtml(content.title)}</a><a href="./${name}.txt">Plain text</a></li>`,
  )
  .join("");
await Bun.write(
  resolve(outputDirectory, "index.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Postil email previews</title><style>body{max-width:720px;margin:48px auto;padding:0 20px;background:#f4f1eb;color:#202528;font:17px/1.55 Arial,sans-serif}h1{font:40px/1.1 Georgia,serif}ul{padding:0;list-style:none}li{margin:20px 0}strong{display:block;margin-bottom:6px;font:13px/1.4 ui-monospace,monospace}a{display:inline-block;margin:0 8px 6px 0;padding:12px 14px;border:1px solid #d8d2c8;border-radius:6px;background:#fffdf9;color:#a53f22;text-decoration:none}a:hover{text-decoration:underline}</style><h1>Postil email previews</h1><p>Every production transactional message rendered with local sample data.</p><ul>${links}</ul></html>`,
);

console.log(outputDirectory);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function operatorPreview(
  name: string,
  payload: OperatorAlertJobPayload,
): readonly [string, ReturnType<typeof operatorAlertEmailContent>["content"]] {
  return [
    name,
    operatorAlertEmailContent(payload, "https://postil.dev/orgs/acme").content,
  ];
}

function customerPreview(
  name: string,
  emailCategory:
    | "billing_summary"
    | "payment_failure"
    | "security"
    | "trial_expiry"
    | "service_incident",
  events: Array<{
    id: number;
    idempotencyKey: string;
    severity: string;
    title: string;
    body: string;
  }>,
): readonly [
  string,
  ReturnType<typeof customerNotificationSummaryEmailContent>["content"],
] {
  return [
    name,
    customerNotificationSummaryEmailContent({
      orgName: "Acme",
      orgSlug: "acme",
      emailCategory,
      events,
      publicOrigin: "https://postil.dev",
    }).content,
  ];
}
