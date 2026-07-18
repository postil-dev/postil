import { createHash } from "node:crypto";

import {
  normalizeVerificationEmail,
  sendTransactionalEmail,
} from "@/lib/email-verification";
import { requireEnv } from "@/lib/env";
import type { OperatorAlertJobPayload } from "@/lib/operator-alerts";

export type { OperatorAlertJobPayload } from "@/lib/operator-alerts";

export async function runOperatorAlertJob(
  payload: OperatorAlertJobPayload,
): Promise<{ messageId: string | null }> {
  validateOperatorAlertPayload(payload);
  const recipient = normalizeVerificationEmail(
    requireEnv("POSTIL_OPERATOR_ALERT_EMAIL"),
    "POSTIL_OPERATOR_ALERT_EMAIL must be a valid email address.",
  );
  if (!recipient) throw new Error("POSTIL_OPERATOR_ALERT_EMAIL is required");
  const dashboardUrl = new URL(
    `/orgs/${encodeURIComponent(payload.orgSlug)}`,
    requireEnv("POSTIL_PUBLIC_URL"),
  ).toString();
  const content = alertContent(payload, dashboardUrl);

  return sendTransactionalEmail({
    recipient,
    subject: content.subject,
    text: content.text,
    idempotencyKey: `postil-operator-${createHash("sha256")
      .update(payload.eventKey)
      .digest("hex")}`,
    apiKey: requireEnv("BREVO_API_KEY"),
  });
}

export function validateOperatorAlertPayload(payload: OperatorAlertJobPayload): void {
  const baseInvalid =
    !["trial_started", "trial_expired", "installation_removed"].includes(
      payload.event,
    ) ||
    !safeLabel(payload.eventKey, 320) ||
    !Number.isSafeInteger(payload.orgId) ||
    payload.orgId <= 0;
  if (
    baseInvalid ||
    !Number.isSafeInteger(payload.githubOwnerId) ||
    payload.githubOwnerId <= 0 ||
    !safeLabel(payload.orgSlug, 160) ||
    !safeLabel(payload.accountLogin, 160)
  ) {
    throw new Error("operator alert job payload is malformed");
  }
  if (payload.event === "trial_started") {
    validateInstallation(payload.accountType, payload.githubInstallationId);
    validateDate(payload.trialEndsAt);
  } else if (payload.event === "installation_removed") {
    validateInstallation(payload.accountType, payload.githubInstallationId);
  } else {
    validateDate(payload.trialEndsAt);
  }
}

function validateInstallation(accountType: string, installationId: number): void {
  if (
    !safeLabel(accountType, 40) ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0
  ) {
    throw new Error("operator alert job payload is malformed");
  }
}

function validateDate(value: string): void {
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new Error("operator alert job payload is malformed");
  }
}

function alertContent(
  payload: OperatorAlertJobPayload,
  dashboardUrl: string,
): { subject: string; text: string[] } {
  const common = [
    "",
    `Account: ${payload.accountLogin}`,
    `GitHub owner ID: ${payload.githubOwnerId}`,
  ];
  if (payload.event === "trial_started") {
    return {
      subject: `New Postil trial: ${payload.accountLogin}`,
      text: [
        "A GitHub owner started a 30-day Postil trial.",
        ...common,
        `Account type: ${payload.accountType}`,
        `GitHub App installation ID: ${payload.githubInstallationId}`,
        `Trial ends: ${new Date(payload.trialEndsAt).toISOString()}`,
        `Dashboard: ${dashboardUrl}`,
      ],
    };
  }
  if (payload.event === "trial_expired") {
    return {
      subject: `Postil trial ended: ${payload.accountLogin}`,
      text: [
        "A Postil trial ended without an active plan.",
        ...common,
        `Trial ended: ${new Date(payload.trialEndsAt).toISOString()}`,
        `Dashboard: ${dashboardUrl}`,
      ],
    };
  }
  return {
    subject: `Postil App removed: ${payload.accountLogin}`,
    text: [
      "A GitHub owner removed the Postil App.",
      ...common,
      `Account type: ${payload.accountType}`,
      `GitHub App installation ID: ${payload.githubInstallationId}`,
      `Dashboard: ${dashboardUrl}`,
    ],
  };
}

function safeLabel(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
