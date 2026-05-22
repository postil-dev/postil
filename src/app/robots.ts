import type { MetadataRoute } from "next";

const crawlableBots = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "PerplexityBot",
  "CCBot",
];

const rules = [
  {
    userAgent: "*",
    allow: "/",
    disallow: ["/install", "/login"],
  },
  ...crawlableBots.map((userAgent) => ({
    userAgent,
    allow: "/",
    disallow: ["/install", "/login"],
  })),
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules,
    sitemap: "https://postil.dev/sitemap.xml",
  };
}
