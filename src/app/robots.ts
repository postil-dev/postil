import type { MetadataRoute } from "next";

const SITE_URL = "https://postil.dev";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Session-gated app surfaces and API routes carry no SEO value.
      // Trailing slashes keep these from prefix-matching unrelated routes.
      disallow: ["/api/", "/reports/", "/orgs/", "/login"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
