import type { NextConfig } from "next";

// Enforced CSP. The site loads only first-party assets plus a small,
// same-origin PostHog relay, so the policy is restrictive by default. Next.js
// emits inline bootstrap scripts and the
// pages embed inline JSON-LD, so script-src needs 'unsafe-inline' until nonces
// are wired through middleware; inline style attributes need it on style-src.
const developmentScriptPolicy =
  process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";
const posthogIngestionHost = normalizedPosthogHost(
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com",
);
const posthogAssetHost = posthogAssetsHost(posthogIngestionHost);
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${developmentScriptPolicy}`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  images: {
    // Optimized image responses are content-addressed by their query string;
    // let browsers and the CDN keep them for a year.
    minimumCacheTTL: 31536000,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/relay/static/:path*",
        destination: `${posthogAssetHost}/static/:path*`,
      },
      {
        source: "/relay/array/:path*",
        destination: `${posthogAssetHost}/array/:path*`,
      },
      {
        source: "/relay/i/v0/e/:path*",
        destination: `${posthogIngestionHost}/i/v0/e/:path*`,
      },
      {
        source: "/relay/e/:path*",
        destination: `${posthogIngestionHost}/e/:path*`,
      },
    ];
  },
  async redirects() {
    return [
      {
        // /docs/gitlab folded into the forges section; keep the old URL alive.
        source: "/docs/gitlab",
        destination: "/docs/forges/gitlab",
        permanent: true,
      },
      {
        // Retired marketing route; keep crawlers and old links on the public story.
        source: "/about",
        destination: "/why-postil",
        permanent: true,
      },
      {
        source: "/index.html",
        destination: "/",
        permanent: true,
      },
    ];
  },
};

function normalizedPosthogHost(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("NEXT_PUBLIC_POSTHOG_HOST must use http or https");
  }
  return url.toString().replace(/\/+$/, "");
}

function posthogAssetsHost(ingestionHost: string): string {
  if (ingestionHost === "https://eu.i.posthog.com") return "https://eu-assets.i.posthog.com";
  if (ingestionHost === "https://us.i.posthog.com") return "https://us-assets.i.posthog.com";
  return ingestionHost;
}

export default nextConfig;
