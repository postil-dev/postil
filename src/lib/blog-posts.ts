import type { Metadata } from "next";

const SITE_ORIGIN = "https://postil.dev";
const PUBLICATION_DATE = /^\d{4}-\d{2}-\d{2}$/;
const publicationDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export interface BlogPost {
  slug: string;
  publishedOn: string;
  title: string;
  description: string;
  socialDescription: string;
  structuredDescription?: string;
  excerpt: string;
}

export const BLOG_POSTS = [
  {
    slug: "silence-rate",
    publishedOn: "2026-06-13",
    title: "The silence rate: an ongoing AI code review metric",
    description:
      "GitHub published a one-off Copilot silence figure. Postil makes silence rate an ongoing per-organization metric: how often the tool correctly says nothing.",
    socialDescription:
      "Developers stop reading AI reviewers above roughly 30% false positives. The metric that predicts it: how often the tool correctly says nothing.",
    excerpt:
      "GitHub published a one-off Copilot silence figure. Postil makes silence rate an ongoing per-organization metric: how often the tool says nothing.",
  },
  {
    slug: "where-does-your-code-go",
    publishedOn: "2026-06-27",
    title: "Where does your code actually go? A data-flow audit of AI code review tools",
    description:
      "AI code reviewers differ less on what they find than on where your code goes, who keeps it, and whether it trains a model. A class-by-class data-flow audit: retention, training, and where inference runs.",
    socialDescription:
      "Retention, training, and where inference runs: a class-by-class data-flow audit of AI code review tools.",
    excerpt:
      "AI reviewers differ less on what they find than on where your code goes, who keeps it, and whether it trains a model. A class-by-class audit of retention, training, and inference location.",
  },
  {
    slug: "self-hosted-ai-code-review",
    publishedOn: "2026-07-08",
    title: "Self-hosted AI code review without the 500-seat enterprise gate",
    description:
      "CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer it at all. Run an Apache-2.0 AI code reviewer locally with Ollama, with no seat fees or license cost.",
    socialDescription:
      "CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer it at all. Run an Apache-2.0 AI code reviewer locally with Ollama.",
    excerpt:
      "CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer it at all. Run an Apache-2.0 reviewer locally with Ollama, with no seat fees or license cost.",
  },
  {
    slug: "ai-code-review-benchmarks",
    publishedOn: "2026-07-08",
    title: "How to compare AI code review benchmarks",
    description:
      "Read the dataset, scoring rules, clean cases, and failed runs before comparing AI code review scores. Find and run the public Postil benchmark suite.",
    socialDescription:
      "Read the dataset, scoring rules, clean cases, and failed runs before comparing AI code review scores. Find and run the public Postil benchmark suite.",
    excerpt:
      "Read the dataset, scoring rules, clean cases, and failed runs before comparing AI code review scores. Find and run the public Postil benchmark suite.",
  },
  {
    slug: "why-copilot-cant-block-your-merge",
    publishedOn: "2026-07-08",
    title: "Why GitHub Copilot can't block your merge (and how a real AI merge gate works)",
    description:
      "GitHub branch protection blocks on required status checks, not on review comments. Copilot code review posts a Comment, Claude Code review concludes neutral, and Macroscope defaults to neutral checks unless configured to fail.",
    socialDescription:
      "Branch protection blocks on required status checks, not review comments. A Comment-only or neutral-concluding reviewer cannot gate a merge. Here is the mechanic.",
    excerpt:
      "Branch protection blocks on required status checks that conclude failure, not on review comments or neutral checks. Copilot posts a Comment, Claude Code review concludes neutral, and Macroscope defaults neutral unless configured to fail.",
  },
  {
    slug: "ai-code-review-pricing-2026",
    publishedOn: "2026-07-08",
    title: "AI code review pricing in 2026: what a 20-developer team actually pays",
    description:
      "Four AI code review vendors changed pricing models in roughly ninety days. We run the same 20-developer team through CodeRabbit, Qodo, Greptile, Macroscope, Copilot, Bugbot, and Postil, with every assumption stated and every price sourced.",
    socialDescription:
      "The same 20-developer team priced through seven AI code review tools, with every assumption stated and every price sourced.",
    structuredDescription:
      "The same 20-developer team priced through seven AI code review tools, with every assumption stated and every price sourced.",
    excerpt:
      "Four vendors changed pricing models in ninety days. We run the same 20-developer team through seven tools, assumptions stated, arithmetic shown, every price sourced.",
  },
  {
    slug: "best-ai-code-review-tools-2026",
    publishedOn: "2026-07-08",
    title: "Best AI code review tools in 2026: an evidence-first comparison",
    description:
      "CodeRabbit, Qodo, Macroscope, Greptile, Copilot code review, Cursor Bugbot, and Postil compared on noise, merge gating, self-hosting, data handling, and source-linked pricing.",
    socialDescription:
      "Seven AI code reviewers compared on noise, merge gating, self-hosting, data handling, and pricing. Every claim sourced.",
    excerpt:
      "CodeRabbit, Qodo, Macroscope, Greptile, Copilot, Bugbot, and Postil, compared on noise, merge gating, self-hosting, data handling, and a pricing landscape that changed four times in ninety days. Every claim sourced.",
  },
  {
    slug: "the-gate-is-separate-from-the-review",
    publishedOn: "2026-07-11",
    title: "The gate is separate from the review",
    description:
      "Use postil/gate for the required merge verdict and postil/review for advisory findings. Understand blocking rules and incomplete reviews.",
    socialDescription:
      "Use postil/gate for the required merge verdict and postil/review for advisory findings. Understand blocking rules and incomplete reviews.",
    excerpt:
      "Use postil/gate for the required merge verdict and postil/review for advisory findings. Understand blocking rules and incomplete reviews.",
  },
  {
    slug: "evidence-has-to-link-back",
    publishedOn: "2026-07-11",
    title: "How to verify an AI code review finding",
    description:
      "Trace a review finding to the code it describes, inspect the gate result, and understand what a public example can establish.",
    socialDescription:
      "Trace a review finding to the code it describes, inspect the gate result, and understand what a public example can establish.",
    excerpt:
      "Trace a review finding to the code it describes, inspect the gate result, and understand what a public example can establish.",
  },
  {
    slug: "the-least-useful-number",
    publishedOn: "2026-08-19",
    title: "How to read a model benchmark beyond detection rate",
    description:
      "Compare detection, clean-case silence, gate correctness, latency, and measured review cost on the Postil benchmark corpus.",
    socialDescription:
      "Compare detection, clean-case silence, gate correctness, latency, and measured review cost on the Postil benchmark corpus.",
    excerpt:
      "Compare detection, clean-case silence, gate correctness, latency, and measured review cost on the Postil benchmark corpus.",
  },
] as const satisfies readonly BlogPost[];

export type BlogPostSlug = (typeof BLOG_POSTS)[number]["slug"];

export function getBlogPost(slug: BlogPostSlug): BlogPost {
  const post = BLOG_POSTS.find((candidate) => candidate.slug === slug);
  if (!post) throw new Error(`unknown blog post: ${slug}`);
  return post;
}

export function orderedBlogPosts(posts: readonly BlogPost[] = BLOG_POSTS): BlogPost[] {
  return posts
    .map((post) => ({
      post,
      publishedAt: parsePublicationDate(post.publishedOn).getTime(),
    }))
    .sort((left, right) =>
      right.publishedAt - left.publishedAt ||
      left.post.slug.localeCompare(right.post.slug)
    )
    .map(({ post }) => post);
}

export function formatBlogPublicationDate(publishedOn: string): string {
  return publicationDateFormatter.format(parsePublicationDate(publishedOn));
}

export function blogPostMetadata(post: BlogPost): Metadata {
  const path = `/blog/${post.slug}`;
  const publishedTime = parsePublicationDate(post.publishedOn).toISOString();
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: path },
    openGraph: {
      type: "article",
      publishedTime,
      title: post.title,
      description: post.socialDescription,
      url: `${SITE_ORIGIN}${path}`,
      images: ["/opengraph-image"],
    },
  };
}

export function blogPostJsonLd(post: BlogPost): Record<string, unknown> {
  const url = `${SITE_ORIGIN}/blog/${post.slug}`;
  parsePublicationDate(post.publishedOn);
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.structuredDescription ?? post.description,
    url,
    datePublished: post.publishedOn,
    image: `${SITE_ORIGIN}/opengraph-image`,
    author: {
      "@type": "Organization",
      name: "Postil",
      url: SITE_ORIGIN,
    },
  };
}

function parsePublicationDate(publishedOn: string): Date {
  if (!PUBLICATION_DATE.test(publishedOn)) {
    throw new Error(`invalid blog publication date: ${publishedOn}`);
  }
  const parsed = new Date(`${publishedOn}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== publishedOn
  ) {
    throw new Error(`invalid blog publication date: ${publishedOn}`);
  }
  return parsed;
}
