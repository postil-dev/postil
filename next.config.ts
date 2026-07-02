import type { NextConfig } from "next";

// Enforced CSP. The site loads only first-party assets plus a small,
// explicit allowlist of cross-origin fetches, so the policy is restrictive
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
  // openrouter.ai: /docs/models fetches the live model catalog client-side
  // for pricing, never committed as static numbers.
  "connect-src 'self' https://eu.i.posthog.com https://us.i.posthog.com https://openrouter.ai",
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
  async redirects() {
    return [
      {
        // /docs/gitlab folded into the forges section; keep the old URL alive.
        source: "/docs/gitlab",
        destination: "/docs/forges/gitlab",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
