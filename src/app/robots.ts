import type { MetadataRoute } from "next";

const crawlableBots = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "PerplexityBot",
  "CCBot",
];

const protectedPaths = ["/install", "/login"];

const rules = [
  {
    userAgent: "*",
    allow: "/",
    disallow: protectedPaths,
  },
  ...crawlableBots.map((userAgent) => ({
    userAgent,
    allow: "/",
    disallow: protectedPaths,
  })),
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules,
    sitemap: "https://postil.dev/sitemap.xml",
  };
}
