export const MANDATORY_ORGANIZATION_EMAILS = [
  "security",
  "verification",
  "payment_failure",
  "trial_expiry",
  "service_incident",
] as const;

export const OPTIONAL_ORGANIZATION_EMAILS = [
  "billing_summary",
  "service_summary",
] as const;

export type MandatoryOrganizationEmail =
  (typeof MANDATORY_ORGANIZATION_EMAILS)[number];
export type OptionalOrganizationEmail =
  (typeof OPTIONAL_ORGANIZATION_EMAILS)[number];
export type OrganizationEmailCategory =
  | MandatoryOrganizationEmail
  | OptionalOrganizationEmail;

export interface OrganizationNotificationPreferences {
  billingSummaryEmail: boolean;
  serviceSummaryEmail: boolean;
}

export const DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES: OrganizationNotificationPreferences = {
  billingSummaryEmail: true,
  serviceSummaryEmail: true,
};

/** Mandatory account and service protection emails cannot be disabled. */
export function organizationEmailEnabled(
  category: OrganizationEmailCategory,
  preferences: OrganizationNotificationPreferences,
): boolean {
  if (category === "billing_summary") return preferences.billingSummaryEmail;
  if (category === "service_summary") return preferences.serviceSummaryEmail;
  return true;
}
