import { describe, expect, test } from "bun:test";

import {
  assertApplicationEmailBody,
  renderTransactionalEmail,
  sendTransactionalEmail,
  type TransactionalEmailContent,
} from "@/lib/transactional-email";

const representative: TransactionalEmailContent = {
  preheader: "Acme needs a billing-contact confirmation.",
  category: "Verification",
  title: "Verify billing contact email",
  summary:
    "Confirm this address before Postil records it as the organization's billing contact.",
  organization: "Acme & Sons",
  reason:
    "Someone entered this address as the Postil billing contact for Acme & Sons.",
  details: [{ label: "Requested by", value: "Organization administrator" }],
  action: {
    label: "Verify billing contact",
    url: "https://postil.dev/verify/billing-contact",
  },
  note: "This link expires in 24 hours.",
  intent: "action",
};

describe("transactional email renderer", () => {
  test("renders a responsive, dark-mode-aware hierarchy and plain-text counterpart", () => {
    const rendered = renderTransactionalEmail(representative);

    expect(rendered.html).toContain(
      '<meta name="color-scheme" content="light dark">',
    );
    expect(rendered.html).toContain("@media only screen and (max-width:620px)");
    expect(rendered.html).toContain("@media (prefers-color-scheme:dark)");
    expect(rendered.html).toContain("mso-padding-alt:12px 18px");
    expect(rendered.html).toContain('role="button"');
    expect(rendered.html).toContain("Why you received this");
    expect(rendered.html).toContain("Acme &amp; Sons");
    expect(rendered.text).toContain("Organization: Acme & Sons");
    expect(rendered.text).toContain(
      "Verify billing contact: https://postil.dev/verify/billing-contact",
    );
    expect(rendered.text).toContain("Why you received this:");
  });

  test("allows only the expected HTTPS action link in application-supplied HTML", () => {
    const { html } = renderTransactionalEmail(representative);
    expect(() =>
      assertApplicationEmailBody(html, representative.action?.url),
    ).not.toThrow();
    expect(html).not.toMatch(
      /<(?:img|script|iframe|object|embed|video|audio|source|link)\b/i,
    );
    expect(() =>
      assertApplicationEmailBody(
        `${html}<img src="https://example.com/pixel">`,
        representative.action?.url,
      ),
    ).toThrow("remote-content capability");
    expect(() =>
      assertApplicationEmailBody(
        `${html}<a href="https://example.com">extra</a>`,
        representative.action?.url,
      ),
    ).toThrow("unexpected link");
  });

  test("escapes untrusted content and rejects unsafe action URLs", () => {
    const rendered = renderTransactionalEmail({
      ...representative,
      organization: '<img src="https://tracker.example/pixel">',
    });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain(
      "&lt;img src=&quot;https://tracker.example/pixel&quot;&gt;",
    );
    expect(() =>
      renderTransactionalEmail({
        ...representative,
        action: { label: "Unsafe", url: "javascript:alert(1)" },
      }),
    ).toThrow(
      "transactional email action URL must be an HTTPS URL without credentials",
    );
  });

  test("sends HTML and text through the existing Brevo API with idempotency", async () => {
    let request: { input: string; init?: RequestInit } | undefined;
    const result = await sendTransactionalEmail({
      recipient: "billing@example.com",
      subject: "Verify your Postil billing contact",
      content: representative,
      idempotencyKey: "verification-preview",
      apiKey: "brevo-test-key",
      fetchImpl: async (input, init) => {
        request = { input: String(input), init };
        return Response.json({ messageId: "message-preview" }, { status: 201 });
      },
    });
    const body = JSON.parse(String(request?.init?.body)) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({ messageId: "message-preview" });
    expect(request?.input).toBe("https://api.brevo.com/v3/smtp/email");
    expect(request?.init?.headers).toMatchObject({
      accept: "application/json",
      "api-key": "brevo-test-key",
      "content-type": "application/json",
    });
    expect(body.htmlContent).toContain("Verify billing contact email");
    expect(body.textContent).toContain("Why you received this:");
    expect(body.headers).toEqual({ "Idempotency-Key": "verification-preview" });
    expect(body).not.toHaveProperty("templateId");
  });

  test("rejects malformed envelope fields before provider access", async () => {
    const fetchImpl = async () => {
      throw new Error("provider should not be called");
    };
    await expect(
      sendTransactionalEmail({
        recipient: "not-an-address",
        subject: "Valid subject",
        content: representative,
        idempotencyKey: "invalid-recipient",
        apiKey: "brevo-test-key",
        fetchImpl,
      }),
    ).rejects.toThrow("recipient must be a valid email address");
    await expect(
      sendTransactionalEmail({
        recipient: "billing@example.com",
        subject: "Injected\r\nBcc: third-party@example.com",
        content: representative,
        idempotencyKey: "invalid-subject",
        apiKey: "brevo-test-key",
        fetchImpl,
      }),
    ).rejects.toThrow("subject is invalid");
    await expect(
      sendTransactionalEmail({
        recipient: "billing@example.com",
        subject: "Valid subject",
        content: representative,
        idempotencyKey: "invalid\r\nX-Injected: value",
        apiKey: "brevo-test-key",
        fetchImpl,
      }),
    ).rejects.toThrow("idempotency key is invalid");
  });
});
