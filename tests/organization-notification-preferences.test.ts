import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES,
  MANDATORY_ORGANIZATION_EMAILS,
  organizationEmailEnabled,
} from "@/lib/organization-notification-preferences";

describe("organization email preferences", () => {
  test("keeps mandatory transactional categories enabled", () => {
    const allOptionalEmailDisabled = {
      billingSummaryEmail: false,
      serviceSummaryEmail: false,
    };

    for (const category of MANDATORY_ORGANIZATION_EMAILS) {
      expect(organizationEmailEnabled(category, allOptionalEmailDisabled)).toBe(
        true,
      );
    }
  });

  test("applies organization choices only to optional summaries", () => {
    expect(
      organizationEmailEnabled("billing_summary", {
        billingSummaryEmail: false,
        serviceSummaryEmail: true,
      }),
    ).toBe(false);
    expect(
      organizationEmailEnabled("service_summary", {
        billingSummaryEmail: false,
        serviceSummaryEmail: true,
      }),
    ).toBe(true);
    expect(DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES).toEqual({
      billingSummaryEmail: true,
      serviceSummaryEmail: true,
    });
  });
});
