import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PrivateBillingNotice } from "@/components/private-billing-notice";

describe("private repository billing notice", () => {
  test("explains the private-only pause and links admins to billing", () => {
    const markup = renderToStaticMarkup(
      <PrivateBillingNotice
        orgSlug="acme"
        decision={{
          allowed: false,
          reason: "no_entitlement",
          entitlement: null,
          usageMicros: 0,
          usageLimitMicros: null,
        }}
      />,
    );
    expect(markup).toContain("Private repositories are paused");
    expect(markup).toContain("Public repositories are unaffected");
    expect(markup).toContain('href="/orgs/acme/billing"');
  });

  test("renders nothing while private processing is eligible", () => {
    expect(
      renderToStaticMarkup(
        <PrivateBillingNotice
          orgSlug="acme"
          decision={{
            allowed: true,
            reason: "active_subscription",
            entitlement: null,
            usageMicros: 0,
            usageLimitMicros: null,
          }}
        />,
      ),
    ).toBe("");
  });

  test("surfaces past-due grace and approaching hosted cap", () => {
    for (const decision of [
      {
        allowed: true as const,
        reason: "past_due_grace" as const,
        entitlement: null,
        usageMicros: 10,
        usageLimitMicros: 100,
      },
      {
        allowed: true as const,
        reason: "active_subscription" as const,
        entitlement: null,
        usageMicros: 80,
        usageLimitMicros: 100,
      },
    ]) {
      const markup = renderToStaticMarkup(
        <PrivateBillingNotice orgSlug="acme" decision={decision} />,
      );
      expect(markup).toContain("View billing status");
    }
  });
});
