import type { NextConfig } from "next";

// Enforced CSP. The site loads only first-party assets (verified: no
// cross-origin requests in a full render trace), so the policy is restrictive
// by default. Next.js emits inline bootstrap scripts and the pages embed inline
// JSON-LD, so script-src needs 'unsafe-inline' until nonces are wired through
// middleware; inline style attributes need it on style-src.
const csp = [
  "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://eu.i.posthog.com https://us.i.posthog.com",
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
};

export default nextConfig;
