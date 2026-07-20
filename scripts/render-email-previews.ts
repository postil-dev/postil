import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { billingContactVerificationEmailContent } from "@/lib/billing-contact-verification";
import type { OperatorAlertJobPayload } from "@/lib/operator-alerts";
import {
  privateMonitoringIncidentEmailContent,
  privateMonitoringPassFailureEmailContent,
} from "@/lib/private-monitoring";
import {
  assertApplicationEmailBody,
  renderTransactionalEmail,
} from "@/lib/transactional-email";
import { operatorAlertEmailContent } from "@/worker/operator-alert";

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
    "production-monitor-opened",
    privateMonitoringIncidentEmailContent(
      {
        kind: "opened",
        severity: "critical",
        summary: "Review worker heartbeat is stale",
        detail: "No recent worker heartbeat has been recorded.",
      },
      "https://postil.dev/operator#monitoring",
    ),
  ],
  [
    "production-monitor-reminder",
    privateMonitoringIncidentEmailContent(
      {
        kind: "reminder",
        severity: "warning",
        summary: "Billing reconciliation needs attention",
        detail: "The incident remains open.",
      },
      "https://postil.dev/operator#monitoring",
    ),
  ],
  [
    "production-monitor-resolved",
    privateMonitoringIncidentEmailContent(
      {
        kind: "resolved",
        severity: "critical",
        summary: "Review worker heartbeat recovered",
        detail: "The worker heartbeat is fresh.",
      },
      "https://postil.dev/operator#monitoring",
    ),
  ],
  [
    "production-monitor-unavailable",
    privateMonitoringPassFailureEmailContent("https://postil.dev"),
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
