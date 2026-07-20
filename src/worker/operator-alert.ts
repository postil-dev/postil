import { createHash } from "node:crypto";

import { normalizeVerificationEmail } from "@/lib/email-verification";
import { requireEnv } from "@/lib/env";
import { sendOperatorNotification } from "@/lib/operator-notifications";
import { operatorAlertEmailContent } from "@/lib/operator-alert-email";
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
  const content = operatorAlertEmailContent(payload, dashboardUrl);

  return sendOperatorNotification({
    recipient,
    subject: content.subject,
    content: content.content,
    idempotencyKey: `postil-operator-${createHash("sha256")
      .update(payload.eventKey)
      .digest("hex")}`,
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

function safeLabel(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
