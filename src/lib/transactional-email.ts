import { createHash } from "node:crypto";

import { optionalEnv } from "@/lib/env";

/**
 * Brevo retains `smtp` in this Messaging API route name. Postil calls it only
 * as an authenticated HTTPS REST endpoint and does not use an SMTP transport.
 */
const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;
const UUID_DNS_NAMESPACE = Buffer.from(
  "6ba7b8109dad11d180b400c04fd430c8",
  "hex",
);

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface TransactionalEmailProviderInput {
  recipient: string;
  sender: { name: string; email: string };
  subject: string;
  rendered: RenderedTransactionalEmail;
  stableIdempotencyKey: string;
  credential: string;
  fetchImpl: Fetch;
}

export type TransactionalEmailIntent =
  "action" | "notice" | "success" | "warning" | "critical";

export interface TransactionalEmailDetail {
  label: string;
  value: string;
}

export interface TransactionalEmailContent {
  preheader: string;
  category: string;
  title: string;
  summary: string;
  reason: string;
  organization?: string;
  details?: TransactionalEmailDetail[];
  action?: { label: string; url: string };
  note?: string;
  intent?: TransactionalEmailIntent;
}

export interface RenderedTransactionalEmail {
  html: string;
  text: string;
}

const INTENT_COLORS: Record<TransactionalEmailIntent, string> = {
  action: "#a53f22",
  notice: "#435d69",
  success: "#52644f",
  warning: "#8b491f",
  critical: "#8d2f25",
};

export function renderTransactionalEmail(
  content: TransactionalEmailContent,
): RenderedTransactionalEmail {
  validateTransactionalEmailContent(content);
  if (content.action) validateActionUrl(content.action.url);
  const accent = INTENT_COLORS[content.intent ?? "notice"];
  const details = content.details ?? [];
  const text = [
    "POSTIL",
    content.category.toUpperCase(),
    "",
    content.title,
    "",
    content.summary,
    "",
    ...(content.organization
      ? [`Organization: ${content.organization}`, ""]
      : []),
    ...details.map(({ label, value }) => `${label}: ${value}`),
    ...(details.length ? [""] : []),
    ...(content.action
      ? [`${content.action.label}: ${content.action.url}`, ""]
      : []),
    ...(content.note ? [content.note, ""] : []),
    `Why you received this: ${content.reason}`,
    "",
    "Postil · Quiet AI code review for GitHub",
  ].join("\n");

  const detailRows = details
    .map(
      ({ label, value }) => `
        <tr>
          <td class="detail-label" style="padding:8px 16px 8px 0;color:#6b6a66;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
          <td class="detail-value" style="padding:8px 0;color:#202528;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");
  const organization = content.organization
    ? `<p class="organization" style="margin:0 0 20px;color:#4f514f;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;"><strong style="color:#202528;">Organization</strong><br>${escapeHtml(content.organization)}</p>`
    : "";
  const detailTable = detailRows
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;border-top:1px solid #d8d2c8;border-bottom:1px solid #d8d2c8;">${detailRows}</table>`
    : "";
  const action = content.action
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 12px;"><tr><td bgcolor="${accent}" style="border-radius:4px;mso-padding-alt:12px 18px;"><a role="button" href="${escapeAttribute(content.action.url)}" style="display:inline-block;padding:12px 18px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:20px;text-decoration:none;">${escapeHtml(content.action.label)}</a></td></tr></table><p class="action-url" style="margin:0 0 24px;color:#6b6a66;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;word-break:break-all;">${escapeHtml(content.action.url)}</p>`
    : "";
  const note = content.note
    ? `<p class="note" style="margin:20px 0 0;padding:14px 16px;border-left:3px solid ${accent};background:#f3efe7;color:#424644;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;">${escapeHtml(content.note)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(content.title)}</title>
  <style>
    @media only screen and (max-width:620px) {
      .email-shell { width:100% !important; }
      .email-card { padding:28px 22px !important; }
      .email-title { font-size:28px !important; line-height:33px !important; }
      .detail-label { display:block !important; padding-bottom:0 !important; white-space:normal !important; }
      .detail-value { display:block !important; padding-top:0 !important; }
    }
    @media (prefers-color-scheme:dark) {
      .email-page { background:#171918 !important; }
      .email-card { background:#222523 !important; border-color:#464943 !important; }
      .wordmark, .email-title, .organization strong, .detail-value { color:#f2eee6 !important; }
      .category, .summary, .organization, .note, .reason, .footer, .action-url, .detail-label { color:#c8c5bd !important; }
      .note { background:#2c2d29 !important; }
    }
  </style>
</head>
<body class="email-page" style="margin:0;padding:0;background:#f4f1eb;">
  <div style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(content.preheader)}&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-page" style="background:#f4f1eb;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="email-shell" style="width:100%;max-width:600px;">
          <tr>
            <td class="email-card" style="padding:38px 42px;background:#fffdf9;border:1px solid #d8d2c8;border-radius:6px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 30px;">
                <tr>
                  <td width="50%" class="wordmark" style="width:50%;color:#202528;font-family:Georgia,'Times New Roman',serif;font-size:25px;font-weight:700;line-height:28px;white-space:nowrap;">Postil</td>
                  <td width="50%" class="category" align="right" style="width:50%;color:${accent};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.16em;line-height:18px;text-transform:uppercase;">${escapeHtml(content.category)}</td>
                </tr>
              </table>
              <div style="width:36px;height:3px;margin:0 0 20px;background:${accent};font-size:0;line-height:0;">&nbsp;</div>
              <h1 class="email-title" style="margin:0 0 14px;color:#202528;font-family:Georgia,'Times New Roman',serif;font-size:34px;font-weight:400;line-height:40px;">${escapeHtml(content.title)}</h1>
              <p class="summary" style="margin:0 0 24px;color:#424644;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:25px;">${escapeHtml(content.summary)}</p>
              ${organization}
              ${detailTable}
              ${action}
              ${note}
              <p class="reason" style="margin:28px 0 0;padding-top:18px;border-top:1px solid #d8d2c8;color:#6b6a66;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;"><strong>Why you received this</strong><br>${escapeHtml(content.reason)}</p>
            </td>
          </tr>
          <tr>
            <td class="footer" style="padding:16px 8px;color:#77756f;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:17px;text-align:center;">Postil · Quiet AI code review for GitHub</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, text };
}

export function assertApplicationEmailBody(
  html: string,
  actionUrl?: string,
): void {
  if (
    /<(?:img|script|iframe|object|embed|video|audio|source|link)\b/i.test(
      html,
    ) ||
    /\b(?:src|srcset|background)\s*=/i.test(html) ||
    /(?:@import|url\s*\()/i.test(html)
  ) {
    throw new Error("transactional email contains a remote-content capability");
  }
  const links = [...html.matchAll(/\bhref="([^"]+)"/gi)].map(
    (match) => match[1],
  );
  const expectedLinks = actionUrl ? [escapeAttribute(actionUrl)] : [];
  if (
    links.length !== expectedLinks.length ||
    links.some((link, index) => link !== expectedLinks[index])
  ) {
    throw new Error("transactional email contains an unexpected link");
  }
}

export async function sendTransactionalEmail(input: {
  recipient: string;
  subject: string;
  content: TransactionalEmailContent;
  idempotencyKey: string;
  /** Brevo HTTPS API credential, resolved through a required env boundary by every production caller. */
  apiKey: string;
  fetchImpl?: Fetch;
}): Promise<{ messageId: string | null }> {
  if (!isEmailAddress(input.recipient)) {
    throw new Error(
      "transactional email recipient must be a valid email address",
    );
  }
  if (!input.subject.trim() || /[\r\n]/.test(input.subject)) {
    throw new Error("transactional email subject is invalid");
  }
  if (!/^[!-~]{1,200}$/.test(input.idempotencyKey)) {
    throw new Error("idempotency key is invalid");
  }
  if (!input.apiKey.trim() || /[\r\n]/.test(input.apiKey)) {
    throw new Error("API key is invalid");
  }
  const rendered = renderTransactionalEmail(input.content);
  assertApplicationEmailBody(rendered.html, input.content.action?.url);
  const sender = {
    name:
      optionalEnv("POSTIL_EMAIL_FROM_NAME") ??
      (optionalEnv("POSTIL_ESCALATION_FROM_NAME", "Postil") as string),
    email:
      optionalEnv("POSTIL_EMAIL_FROM_EMAIL") ??
      (optionalEnv(
        "POSTIL_ESCALATION_FROM_EMAIL",
        "reviews@mail.postil.dev",
      ) as string),
  };
  if (!isEmailAddress(sender.email) || /[\r\n]/.test(sender.name)) {
    throw new Error("transactional email sender is invalid");
  }
  return deliverWithBrevo({
    recipient: input.recipient,
    sender,
    subject: input.subject,
    rendered,
    stableIdempotencyKey: input.idempotencyKey,
    credential: input.apiKey,
    fetchImpl: input.fetchImpl ?? fetch,
  });
}

/**
 * Provider-specific delivery is isolated from message construction. Product
 * and operator callers depend only on the transport-neutral send contract.
 */
async function deliverWithBrevo(
  input: TransactionalEmailProviderInput,
): Promise<{ messageId: string | null }> {
  const response = await input.fetchImpl(BREVO_SEND_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": input.credential,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: input.sender,
      to: [{ email: input.recipient }],
      subject: input.subject,
      htmlContent: input.rendered.html,
      textContent: input.rendered.text,
      headers: {
        "Idempotency-Key": brevoIdempotencyUuid(input.stableIdempotencyKey),
      },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
  });
  const responseText = await response.text();
  let parsed: { code?: unknown; messageId?: unknown } = {};
  try {
    parsed = JSON.parse(responseText) as typeof parsed;
  } catch {
    parsed = {};
  }
  const providerDuplicate =
    response.status === 400 && parsed.code === "duplicate_parameter";
  if (!response.ok && !providerDuplicate) {
    throw new Error(`Brevo transactional email failed: ${response.status}`);
  }
  if (
    response.ok &&
    (typeof parsed.messageId !== "string" || !parsed.messageId.trim())
  ) {
    throw new Error("Brevo transactional email returned no message ID");
  }
  return {
    messageId: typeof parsed.messageId === "string" ? parsed.messageId : null,
  };
}

/** Derive the provider's required UUID from Postil's stable logical key. */
export function brevoIdempotencyUuid(stableKey: string): string {
  const bytes = createHash("sha1")
    .update(UUID_DNS_NAMESPACE)
    .update("postil.dev:transactional-email:", "utf8")
    .update(stableKey, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function isEmailAddress(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function validateActionUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(
      "transactional email action URL must be an HTTPS URL without credentials",
    );
  }
}

function validateTransactionalEmailContent(
  content: TransactionalEmailContent,
): void {
  validateReadableField("preheader", content.preheader, 240);
  validateReadableField("category", content.category, 80);
  validateReadableField("title", content.title, 160);
  validateReadableField("summary", content.summary, 1_000);
  validateReadableField("reason", content.reason, 1_000);
  if (content.organization) {
    validateReadableField("organization", content.organization, 320);
  }
  if ((content.details?.length ?? 0) > 20) {
    throw new Error("transactional email has too many detail rows");
  }
  for (const detail of content.details ?? []) {
    validateReadableField("detail label", detail.label, 120);
    validateReadableField("detail value", detail.value, 1_000);
  }
  if (content.action) {
    validateReadableField("action label", content.action.label, 120);
  }
  if (content.note) validateReadableField("note", content.note, 1_000);
}

function validateReadableField(
  field: string,
  value: string,
  maxLength: number,
): void {
  if (
    !value.trim() ||
    value.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`transactional email ${field} is invalid`);
  }
}
