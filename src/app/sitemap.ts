import type { MetadataRoute } from "next";

import { MODEL_CATALOG_CAPTURE_DATE } from "@/data/models";

const SITE_URL = "https://postil.dev";

// Public, indexable marketing and documentation routes only. Private and API
// surfaces stay out of the index through page metadata and X-Robots-Tag headers.
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
  { path: "/", priority: 1.0, changeFrequency: "weekly", lastModified: "2026-07-08" },
  { path: "/why-postil", priority: 0.9, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/evidence", priority: 0.8, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/how-it-works", priority: 0.8, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/pricing", priority: 0.9, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/install", priority: 0.8, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/security", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/changelog", priority: 0.6, changeFrequency: "weekly", lastModified: "2026-07-17" },
  { path: "/contact", priority: 0.5, changeFrequency: "yearly", lastModified: "2026-07-11" },
  { path: "/vs/coderabbit", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/vs/greptile", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/vs/qodo", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/vs/macroscope", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/vs/copilot", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/blog", priority: 0.7, changeFrequency: "weekly", lastModified: "2026-07-08" },
  { path: "/bench", priority: 0.8, changeFrequency: "monthly", lastModified: MODEL_CATALOG_CAPTURE_DATE },
  {
    path: "/blog/where-does-your-code-go",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-07-08",
  },
  {
    path: "/blog/self-hosted-ai-code-review",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-07-08",
  },
  {
    path: "/blog/best-ai-code-review-tools-2026",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-07-08",
  },
  {
    path: "/blog/ai-code-review-benchmarks",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-07-08",
  },
  { path: "/blog/silence-rate", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-13" },
  {
    path: "/blog/ai-code-review-pricing-2026",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-07-08",
  },
  {
    path: "/blog/the-least-useful-number",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-08-19",
  },
  {
    path: "/blog/why-copilot-cant-block-your-merge",
    priority: 0.7,
    changeFrequency: "monthly",
    lastModified: "2026-07-08",
  },
  { path: "/privacy", priority: 0.4, changeFrequency: "yearly", lastModified: "2026-07-17" },
  { path: "/terms", priority: 0.4, changeFrequency: "yearly", lastModified: "2026-07-08" },
  { path: "/docs", priority: 0.7, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/quickstart", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/coding-agents", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-11" },
  { path: "/docs/config", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/gate", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/plan", priority: 0.5, changeFrequency: "monthly", lastModified: "2026-06-12" },
  { path: "/docs/envelope", priority: 0.5, changeFrequency: "monthly", lastModified: "2026-06-13" },
  { path: "/docs/content-policy", priority: 0.5, changeFrequency: "monthly", lastModified: "2026-07-02" },
  { path: "/docs/cli", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/exit-codes", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/forges", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/forges/github", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/forges/gitlab", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/forges/bitbucket", priority: 0.5, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/forges/azure", priority: 0.5, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/self-hosted", priority: 0.6, changeFrequency: "monthly", lastModified: "2026-07-08" },
  { path: "/docs/models", priority: 0.6, changeFrequency: "monthly", lastModified: MODEL_CATALOG_CAPTURE_DATE },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    lastModified: new Date(route.lastModified),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
