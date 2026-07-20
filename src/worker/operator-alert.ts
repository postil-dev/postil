import { createHash } from "node:crypto";

import { normalizeVerificationEmail } from "@/lib/email-verification";
import { requireEnv } from "@/lib/env";
import { sendOperatorNotification } from "@/lib/operator-notifications";
import type { OperatorAlertJobPayload } from "@/lib/operator-alerts";
import type { TransactionalEmailContent } from "@/lib/transactional-email";

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

export function operatorAlertEmailContent(
  payload: OperatorAlertJobPayload,
  dashboardUrl: string | null,
): { subject: string; content: TransactionalEmailContent } {
  const organization = payload.accountLogin ?? undefined;
  const common = payload.githubOwnerId
    ? [{ label: "GitHub owner ID", value: String(payload.githubOwnerId) }]
    : [];
  const action = dashboardUrl
    ? { label: "Open organization", url: dashboardUrl }
    : undefined;
  const reason =
    "This address is configured to receive Postil operator alerts.";
  if (payload.event === "trial_started") {
    return {
      subject: `New Postil trial: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin} started a 30-day Postil trial.`,
        category: "Trial",
        title: "A trial has started",
        summary: "The 30-day access window is active for this GitHub owner.",
        organization,
        reason,
        details: [
          ...common,
          { label: "Account type", value: payload.accountType },
          {
            label: "Installation ID",
            value: String(payload.githubInstallationId),
          },
          { label: "Trial ends", value: formatUtcDate(payload.trialEndsAt) },
        ],
        action,
        note: "No action is required. Eligible pull requests are reviewed automatically.",
        intent: "success",
      },
    };
  }
  if (payload.event === "trial_expired") {
    return {
      subject: `Postil trial ended: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin}'s Postil trial has ended.`,
        category: "Trial",
        title: "The trial has ended",
        summary:
          "Private-repository reviews are paused because this organization has no active plan.",
        organization,
        reason,
        details: [
          ...common,
          { label: "Trial ended", value: formatUtcDate(payload.trialEndsAt) },
        ],
        action,
        note: "Review the organization before contacting its owner or changing access.",
        intent: "warning",
      },
    };
  }
  if (payload.event === "subscription_started") {
    return {
      subject: `Postil subscription active: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin} activated a Postil subscription.`,
        category: "Billing",
        title: "Subscription active",
        summary: "Self-service billing is active for this organization.",
        organization,
        reason,
        details: [
          ...common,
          {
            label: "Provider subscription",
            value: payload.providerSubscriptionId,
          },
          ...(payload.periodEndsAt
            ? [
                {
                  label: "Period ends",
                  value: formatUtcDate(payload.periodEndsAt),
                },
              ]
            : []),
        ],
        action,
        intent: "success",
      },
    };
  }
  if (payload.event === "subscription_past_due") {
    return {
      subject: `Postil payment past due: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin}'s Postil payment is past due.`,
        category: "Billing",
        title: "Payment needs attention",
        summary: "The provider reports this subscription as past due.",
        organization,
        reason,
        details: [
          ...common,
          {
            label: "Provider subscription",
            value: payload.providerSubscriptionId,
          },
        ],
        action,
        note: "Check the provider record before taking action.",
        intent: "critical",
      },
    };
  }
  if (payload.event === "subscription_canceled") {
    return {
      subject: `Postil subscription ended: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin}'s Postil subscription has ended.`,
        category: "Billing",
        title: "Subscription ended",
        summary: "The provider reports this subscription as canceled.",
        organization,
        reason,
        details: [
          ...common,
          {
            label: "Provider subscription",
            value: payload.providerSubscriptionId,
          },
        ],
        action,
        note: "Review access and the provider record for this organization.",
        intent: "warning",
      },
    };
  }
  if (payload.event === "subscription_paused") {
    return {
      subject: `Postil subscription paused: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin}'s Postil subscription is paused.`,
        category: "Billing",
        title: "Subscription paused",
        summary: "The provider reports this subscription as paused.",
        organization,
        reason,
        details: [
          ...common,
          {
            label: "Provider subscription",
            value: payload.providerSubscriptionId,
          },
        ],
        action,
        note: "Review access and the provider record for this organization.",
        intent: "warning",
      },
    };
  }
  if (payload.event === "billing_anomaly") {
    return {
      subject: payload.accountLogin
        ? `Postil billing needs attention: ${payload.accountLogin}`
        : "Postil billing needs attention",
      content: {
        preheader: "A Postil billing operation needs attention.",
        category: "Incident",
        title: "Billing needs attention",
        summary:
          "A self-service billing operation did not reach a known good state.",
        organization,
        reason,
        details: [
          ...common,
          { label: "Category", value: payload.category },
          { label: "Provider reference", value: payload.providerObjectId },
        ],
        action,
        note: "Inspect the provider event and the corresponding Postil billing state.",
        intent: "critical",
      },
    };
  }
  if (payload.event !== "installation_removed") {
    throw new Error("operator alert job payload is malformed");
  }
  return {
    subject: `Postil App removed: ${payload.accountLogin}`,
    content: {
      preheader: `${payload.accountLogin} removed the Postil GitHub App.`,
      category: "Access",
      title: "GitHub App removed",
      summary:
        "Postil no longer receives GitHub events from this installation.",
      organization,
      reason,
      details: [
        ...common,
        { label: "Account type", value: payload.accountType },
        {
          label: "Installation ID",
          value: String(payload.githubInstallationId),
        },
      ],
      action,
      note: "Confirm whether the removal was expected before contacting the owner.",
      intent: "notice",
    },
  };
}

function formatUtcDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function safeLabel(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
