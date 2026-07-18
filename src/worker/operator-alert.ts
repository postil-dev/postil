import {
  normalizeVerificationEmail,
  sendTransactionalEmail,
} from "@/lib/email-verification";
import { requireEnv } from "@/lib/env";

export interface OperatorAlertJobPayload extends Record<string, unknown> {
  event: "trial_started";
  orgId: number;
  orgSlug: string;
  accountLogin: string;
  accountType: string;
  githubOwnerId: number;
  githubInstallationId: number;
  trialEndsAt: string;
}

export async function runOperatorAlertJob(
  payload: OperatorAlertJobPayload,
): Promise<void> {
  validatePayload(payload);
  const trialEndsAt = new Date(payload.trialEndsAt);
  const recipient = normalizeVerificationEmail(
    requireEnv("POSTIL_OPERATOR_ALERT_EMAIL"),
    "POSTIL_OPERATOR_ALERT_EMAIL must be a valid email address.",
  );
  if (!recipient) throw new Error("POSTIL_OPERATOR_ALERT_EMAIL is required");
  const dashboardUrl = new URL(
    `/orgs/${encodeURIComponent(payload.orgSlug)}`,
    requireEnv("POSTIL_PUBLIC_URL"),
  ).toString();

  await sendTransactionalEmail({
    recipient,
    subject: `New Postil trial: ${payload.accountLogin}`,
    text: [
      "A GitHub owner started a 30-day Postil trial.",
      "",
      `Account: ${payload.accountLogin}`,
      `Account type: ${payload.accountType}`,
      `GitHub owner ID: ${payload.githubOwnerId}`,
      `GitHub App installation ID: ${payload.githubInstallationId}`,
      `Trial ends: ${trialEndsAt.toISOString()}`,
      `Dashboard: ${dashboardUrl}`,
    ],
    idempotencyKey: `operator-alert-trial-started-${payload.githubOwnerId}`,
    apiKey: requireEnv("BREVO_API_KEY"),
  });
}

function validatePayload(payload: OperatorAlertJobPayload): void {
  const trialEndsAt = new Date(payload.trialEndsAt);
  if (
    payload.event !== "trial_started" ||
    !Number.isSafeInteger(payload.orgId) ||
    payload.orgId <= 0 ||
    !Number.isSafeInteger(payload.githubOwnerId) ||
    payload.githubOwnerId <= 0 ||
    !Number.isSafeInteger(payload.githubInstallationId) ||
    payload.githubInstallationId <= 0 ||
    !safeLabel(payload.orgSlug, 160) ||
    !safeLabel(payload.accountLogin, 160) ||
    !safeLabel(payload.accountType, 40) ||
    !Number.isFinite(trialEndsAt.getTime())
  ) {
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
