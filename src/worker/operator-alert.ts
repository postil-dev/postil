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
  const dashboardUrl = payload.orgSlug
    ? new URL(
        `/orgs/${encodeURIComponent(payload.orgSlug)}`,
        requireEnv("POSTIL_PUBLIC_URL"),
      ).toString()
    : null;
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

export function validateOperatorAlertPayload(
  payload: OperatorAlertJobPayload,
): void {
  if (payload.event === "billing_anomaly") {
    const attachedOrgInvalid =
      payload.orgId !== null &&
      (!Number.isSafeInteger(payload.orgId) ||
        payload.orgId <= 0 ||
        !Number.isSafeInteger(payload.githubOwnerId) ||
        (payload.githubOwnerId ?? 0) <= 0 ||
        !safeLabel(payload.orgSlug, 160) ||
        !safeLabel(payload.accountLogin, 160));
    const unmatchedInvalid =
      payload.orgId === null &&
      (payload.githubOwnerId !== null ||
        payload.orgSlug !== null ||
        payload.accountLogin !== null);
    if (
      !safeLabel(payload.eventKey, 320) ||
      !safeLabel(payload.providerObjectId, 64) ||
      attachedOrgInvalid ||
      unmatchedInvalid ||
      ![
        "unmatched_provider_event",
        "checkout_failed",
        "settlement_stale",
        "settlement_failed",
      ].includes(payload.category)
    ) {
      throw new Error("operator alert job payload is malformed");
    }
    return;
  }
  const baseInvalid =
    ![
      "trial_started",
      "trial_expired",
      "installation_removed",
      "subscription_started",
      "subscription_past_due",
      "subscription_paused",
      "subscription_canceled",
      "billing_anomaly",
    ].includes(payload.event) ||
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
  } else if (payload.event === "trial_expired") {
    validateDate(payload.trialEndsAt);
  } else {
    if (!safeLabel(payload.providerSubscriptionId, 64)) {
      throw new Error("operator alert job payload is malformed");
    }
    if (payload.periodEndsAt !== null) {
      validateDate(payload.periodEndsAt);
    }
  }
}

function validateInstallation(
  accountType: string,
  installationId: number,
): void {
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
  dashboardUrl: string | null,
): { subject: string; text: string[] } {
  const common =
    payload.accountLogin && payload.githubOwnerId
      ? [
          "",
          `Account: ${payload.accountLogin}`,
          `GitHub owner ID: ${payload.githubOwnerId}`,
        ]
      : [];
  if (payload.event === "trial_started") {
    return {
      subject: `New Postil trial: ${payload.accountLogin}`,
      text: [
        "A GitHub owner started a 30-day Postil trial.",
        ...common,
        `Account type: ${payload.accountType}`,
        `GitHub App installation ID: ${payload.githubInstallationId}`,
        `Trial ends: ${new Date(payload.trialEndsAt).toISOString()}`,
        ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
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
        ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
      ],
    };
  }
  if (payload.event === "subscription_started") {
    return {
      subject: `Postil subscription active: ${payload.accountLogin}`,
      text: [
        "A customer activated self-service billing.",
        ...common,
        `Provider subscription: ${payload.providerSubscriptionId}`,
        ...(payload.periodEndsAt
          ? [
              `Billing period ends: ${new Date(payload.periodEndsAt).toISOString()}`,
            ]
          : []),
        ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
      ],
    };
  }
  if (payload.event === "subscription_past_due") {
    return {
      subject: `Postil payment past due: ${payload.accountLogin}`,
      text: [
        "A customer subscription is past due.",
        ...common,
        `Provider subscription: ${payload.providerSubscriptionId}`,
        ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
      ],
    };
  }
  if (payload.event === "subscription_canceled") {
    return {
      subject: `Postil subscription ended: ${payload.accountLogin}`,
      text: [
        "A customer subscription ended.",
        ...common,
        `Provider subscription: ${payload.providerSubscriptionId}`,
        ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
      ],
    };
  }
  if (payload.event === "subscription_paused") {
    return {
      subject: `Postil subscription paused: ${payload.accountLogin}`,
      text: [
        "A customer subscription is paused.",
        ...common,
        `Provider subscription: ${payload.providerSubscriptionId}`,
        ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
      ],
    };
  }
  if (payload.event === "billing_anomaly") {
    return {
      subject: payload.accountLogin
        ? `Postil billing needs attention: ${payload.accountLogin}`
        : "Postil billing needs attention",
      text: [
        "A self-service billing operation needs attention.",
        ...common,
        `Category: ${payload.category}`,
        `Provider reference: ${payload.providerObjectId}`,
        ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
      ],
    };
  }
  if (payload.event !== "installation_removed") {
    throw new Error("operator alert job payload is malformed");
  }
  return {
    subject: `Postil App removed: ${payload.accountLogin}`,
    text: [
      "A GitHub owner removed the Postil App.",
      ...common,
      `Account type: ${payload.accountType}`,
      `GitHub App installation ID: ${payload.githubInstallationId}`,
      ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
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
