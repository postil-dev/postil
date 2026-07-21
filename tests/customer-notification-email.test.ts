import { describe, expect, test } from "bun:test";

import {
  customerNotificationEmailCategory,
  customerNotificationSummaryEmailContent,
} from "@/lib/customer-notification-email";
import {
  assertApplicationEmailBody,
  renderTransactionalEmail,
} from "@/lib/transactional-email";

describe("customer notification email", () => {
  test("maps only durable customer event sources to email policy", () => {
    expect(customerNotificationEmailCategory("installation-suspended:1:delivery"))
      .toBe("security");
    expect(customerNotificationEmailCategory("installation-restored:1:delivery"))
      .toBe("security");
    expect(customerNotificationEmailCategory("installation-removed:1:delivery"))
      .toBe("security");
    expect(customerNotificationEmailCategory("subscription-past-due:sub:event"))
      .toBe("payment_failure");
    expect(customerNotificationEmailCategory("billing-settlement-failed:settlement"))
      .toBe("payment_failure");
    expect(customerNotificationEmailCategory("trial-expired:1:date"))
      .toBe("trial_expiry");
    expect(customerNotificationEmailCategory("service-disruption:worker:date"))
      .toBe("service_incident");
    expect(customerNotificationEmailCategory("service-recovery:worker:date"))
      .toBe("service_incident");
    expect(customerNotificationEmailCategory("subscription-restored:sub:event"))
      .toBe("billing_summary");
    expect(customerNotificationEmailCategory("subscription-paused:sub:event"))
      .toBe("billing_summary");
    expect(customerNotificationEmailCategory("subscription-canceled:sub:event"))
      .toBe("billing_summary");
    expect(customerNotificationEmailCategory("trial-started:1")).toBeNull();
    expect(customerNotificationEmailCategory("installation-future:1")).toBeNull();
  });

  test("renders concise HTML and plain text without remote content or private details", () => {
    const message = customerNotificationSummaryEmailContent({
      orgName: "Acme & Sons",
      orgSlug: "acme",
      emailCategory: "billing_summary",
      events: [
        {
          id: 1,
          idempotencyKey: "subscription-restored:sub:event",
          severity: "info",
          title: "Your subscription is active",
          body: "Private-repository reviews are available under your subscription.",
        },
      ],
      publicOrigin: "https://postil.dev",
    });
    const rendered = renderTransactionalEmail(message.content);

    expect(message.subject).toBe("Postil billing summary for Acme & Sons");
    expect(message.content.reason).toContain("billing summaries are enabled");
    expect(rendered.text).toContain("Your subscription is active");
    expect(rendered.html).toContain("Acme &amp; Sons");
    expect(rendered.html).not.toMatch(
      /<(?:img|script|iframe|object|embed|video|audio|source|link)\b/i,
    );
    expect(`${rendered.html}\n${rendered.text}`).not.toMatch(
      /provider|paddle|model|token|cost|stack|exception|operator/i,
    );
    expect(() =>
      assertApplicationEmailBody(
        rendered.html,
        "https://postil.dev/orgs/acme/notifications",
      )
    ).not.toThrow();
  });

  test("refuses categories without a durable summary source", () => {
    const base = {
      orgName: "Acme",
      orgSlug: "acme",
      events: [
        {
          id: 1,
          idempotencyKey: "fixture",
          severity: "info",
          title: "Fixture update",
          body: "Fixture detail.",
        },
      ],
      publicOrigin: "https://postil.dev",
    };
    expect(() =>
      customerNotificationSummaryEmailContent({
        ...base,
        emailCategory: "service_summary",
      })
    ).toThrow("has no durable source");
    expect(() =>
      customerNotificationSummaryEmailContent({
        ...base,
        emailCategory: "verification",
      })
    ).toThrow("has no durable source");
  });

  test("labels a standalone durable recovery as recovered", () => {
    const message = customerNotificationSummaryEmailContent({
      orgName: "Acme",
      orgSlug: "acme",
      emailCategory: "service_incident",
      events: [
        {
          id: 1,
          idempotencyKey: "service-recovery:worker:date",
          severity: "info",
          title: "Hosted reviews are running normally",
          body: "Queued reviews can start normally.",
        },
      ],
      publicOrigin: "https://postil.dev",
    });

    expect(message.subject).toBe("Postil service recovered for Acme");
    expect(message.content.intent).toBe("success");
  });
});
