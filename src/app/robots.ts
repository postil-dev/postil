import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/install", "/login"],
    },
    sitemap: "https://postil.dev/sitemap.xml",
  };
}
