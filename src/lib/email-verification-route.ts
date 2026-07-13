import { NextResponse } from "next/server";

import { publicOrigin } from "@/lib/oauth";

export function verificationConfirmationPage(
  request: Request,
  opts: { action: string; heading: string; description: string },
): NextResponse {
  const url = new URL(request.url);
  const org = url.searchParams.get("org") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const validInput = /^[1-9]\d*$/.test(org) && token.length > 0;
  const form = validInput
    ? `<form method="post" action="${escapeHtml(opts.action)}">
        <input type="hidden" name="org" value="${escapeHtml(org)}">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit">Confirm email</button>
      </form>`
    : "<p>This verification link is invalid.</p>";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>${escapeHtml(opts.heading)} · Postil</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(opts.heading)}</h1>
      <p>${escapeHtml(opts.description)}</p>
      ${form}
    </main>
  </body>
</html>`;
  return new NextResponse(html, {
    status: validInput ? 200 : 400,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export function isSameOriginVerificationPost(request: Request): boolean {
  const expectedOrigin = publicOrigin(request);
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedOrigin;

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  return request.headers.get("sec-fetch-site") === "same-origin";
}

export async function verificationFormValues(
  request: Request,
): Promise<{ orgId: number; token: string } | null> {
  try {
    const form = await request.formData();
    const orgId = Number(form.get("org"));
    const token = form.get("token");
    if (!Number.isSafeInteger(orgId) || orgId <= 0 || typeof token !== "string" || !token) {
      return null;
    }
    return { orgId, token };
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
