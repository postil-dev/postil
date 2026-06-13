import type { MetadataRoute } from "next";

const SITE_URL = "https://postil.dev";

// Public, indexable marketing and documentation routes only. App/dashboard
// surfaces are session-gated and excluded in robots.ts.
const ROUTES: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/why-postil", priority: 0.9, changeFrequency: "monthly" },
  { path: "/evidence", priority: 0.8, changeFrequency: "monthly" },
  { path: "/how-it-works", priority: 0.8, changeFrequency: "monthly" },
  { path: "/pricing", priority: 0.9, changeFrequency: "monthly" },
  { path: "/install", priority: 0.8, changeFrequency: "monthly" },
  { path: "/security", priority: 0.7, changeFrequency: "monthly" },
  { path: "/changelog", priority: 0.6, changeFrequency: "weekly" },
  { path: "/vs/coderabbit", priority: 0.7, changeFrequency: "monthly" },
  { path: "/vs/greptile", priority: 0.7, changeFrequency: "monthly" },
  { path: "/vs/qodo", priority: 0.7, changeFrequency: "monthly" },
  { path: "/vs/macroscope", priority: 0.7, changeFrequency: "monthly" },
  { path: "/vs/copilot", priority: 0.7, changeFrequency: "monthly" },
  { path: "/blog", priority: 0.7, changeFrequency: "weekly" },
  {
    path: "/blog/best-ai-code-review-tools-2026",
    priority: 0.7,
    changeFrequency: "monthly",
  },
  { path: "/blog/silence-rate", priority: 0.6, changeFrequency: "monthly" },
  { path: "/privacy", priority: 0.4, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.4, changeFrequency: "yearly" },
  { path: "/docs", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/quickstart", priority: 0.6, changeFrequency: "monthly" },
  { path: "/docs/config", priority: 0.6, changeFrequency: "monthly" },
  { path: "/docs/gate", priority: 0.6, changeFrequency: "monthly" },
  { path: "/docs/plan", priority: 0.5, changeFrequency: "monthly" },
  { path: "/docs/envelope", priority: 0.5, changeFrequency: "monthly" },
  { path: "/docs/cli", priority: 0.6, changeFrequency: "monthly" },
  { path: "/docs/gitlab", priority: 0.6, changeFrequency: "monthly" },
  { path: "/docs/self-hosted", priority: 0.6, changeFrequency: "monthly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
