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
    slug: "best-ai-code-review-tools-2026",
    publishedOn: "2026-07-08",
    title: "Best AI code review tools in 2026: an evidence-first comparison",
    description:
      "CodeRabbit, Qodo, Macroscope, Greptile, Copilot code review, Cursor Bugbot, and Postil compared on noise, merge gating, self-hosting, data handling, and source-linked pricing, with a worked monthly cost for a 20-developer team.",
    socialDescription:
      "Seven AI code reviewers compared on noise, merge gating, self-hosting, data handling, and pricing, with a worked 20-developer bill. Every claim sourced.",
    structuredDescription:
      "An evidence-first comparison of seven AI code review tools on noise, merge gating, self-hosting, data handling, and pricing, including the 2026 repricing timeline and a worked monthly cost for a 20-developer team under stated assumptions.",
    excerpt:
      "CodeRabbit, Qodo, Macroscope, Greptile, Copilot, Bugbot, and Postil, compared on noise, merge gating, self-hosting, data handling, and a pricing landscape that changed four times in ninety days. Every claim sourced.",
  },
  {
    slug: "the-least-useful-number",
    publishedOn: "2026-08-19",
    title: "Choosing a code review model",
    description:
      "A one-point detection gap between GPT-5.6 Luna and GLM-5.2 hides larger differences in gate decisions, output failures, cost and run-to-run variance. What each benchmark number measures, and which one to weight least.",
    socialDescription:
      "A one-point detection gap between GPT-5.6 Luna and GLM-5.2 hides larger differences in gate decisions, output failures, cost and run-to-run variance. What each benchmark number measures, and which one to weight least.",
    excerpt:
      "A one-point detection gap between GPT-5.6 Luna and GLM-5.2 hides larger differences in gate decisions, output failures, cost and run-to-run variance. What each benchmark number measures, and which one to weight least.",
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
