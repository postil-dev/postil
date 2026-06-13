import type { MetadataRoute } from "next";

const SITE_URL = "https://postil.dev";

// Public, indexable marketing and documentation routes only. App/dashboard
// surfaces are session-gated and excluded in robots.ts.
//
// lastModified is a fixed per-route content date (bump it when a page's
// content meaningfully changes). A request-time `new Date()` made every URL
// look modified on every fetch, which crawlers detect and ignore.
const ROUTES: {
  path: string;
  priority: number;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  lastModified: string;
}[] = [
  { path: "/", priority: 1.0, changeFrequency: "weekly", lastModified: "2026-06-13" },
  { path: "/why-postil", priority: 0.9, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/evidence", priority: 0.8, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/how-it-works", priority: 0.8, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/pricing", priority: 0.9, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/install", priority: 0.8, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/security", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/changelog", priority: 0.6, changeFrequency: "weekly", lastModified: "2026-06-12" },
  { path: "/vs/coderabbit", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/vs/greptile", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/vs/qodo", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/vs/macroscope", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/vs/copilot", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/blog", priority: 0.7, changeFrequency: "weekly", lastModified: "2026-06-13" },
  {
    path: "/blog/best-ai-code-review-tools-2026",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-06-13",
  },
  {
    path: "/blog/ai-code-review-benchmarks",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-06-13",
  },
  { path: "/blog/silence-rate", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-13" },
  {
    path: "/blog/ai-code-review-pricing-2026",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-06-13",
  },
  {
    path: "/blog/why-copilot-cant-block-your-merge",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-06-13",
  },
  { path: "/privacy", priority: 0.4, changeFrequency: "yearly", lastModified: "2026-06-12" },
  { path: "/terms", priority: 0.4, changeFrequency: "yearly", lastModified: "2026-06-12" },
  { path: "/docs", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/quickstart", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/config", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/gate", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/plan", priority: 0.5, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/envelope", priority: 0.5, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/docs/cli", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/gitlab", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/self-hosted", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-12" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    lastModified: new Date(route.lastModified),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
