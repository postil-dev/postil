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
          usageCents: 0,
          usageLimitCents: null,
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
            usageCents: 0,
            usageLimitCents: null,
          }}
        />,
      ),
    ).toBe("");
  });
});
