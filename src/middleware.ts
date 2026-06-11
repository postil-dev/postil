import { type NextRequest, NextResponse } from "next/server";
import { POSTHOG_BROWSER_ORIGIN } from "@/lib/posthog-config";

export function createCsp(nonce: string) {
  const isDevelopment = process.env.NODE_ENV === "development";
  const scriptSrc = [`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`];
  const styleSrc = ["style-src 'self' 'unsafe-inline'"];
  const fontSrc = ["font-src 'self'"];
  const connectSrc = ["connect-src 'self'", POSTHOG_BROWSER_ORIGIN];

  if (isDevelopment) {
    scriptSrc.push("'unsafe-eval'");
    styleSrc.push("https://fonts.googleapis.com");
    fontSrc.push("https://fonts.gstatic.com");
    connectSrc.push("https://www.react-grab.com");
  }

  return [
    "default-src 'none'",
    scriptSrc.join(" "),
    styleSrc.join(" "),
    fontSrc.join(" "),
    "img-src 'self' data:",
    connectSrc.join(" "),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = createCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|api/health$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
