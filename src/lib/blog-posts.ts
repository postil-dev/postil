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
    title: "Four AI code review benchmarks, four home-team winners",
    description:
      "Greptile scored 82% on its own benchmark and 45% when a rival re-ran it. Why vendor code-review benchmarks are marketing in a lab coat, and a five-point test for spotting a rigged one.",
    socialDescription:
      "Greptile scored 82% on its own benchmark and 45% when a rival re-ran it. Why vendor code-review benchmarks are marketing in a lab coat, and a five-point test for spotting a rigged one.",
    excerpt:
      "Greptile scored 82% on its own benchmark and 45% when a rival re-ran it. Why vendor code-review benchmarks can't be trusted at face value, and a five-point test for spotting a rigged one.",
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
      "Postil splits advisory review output from the branch-protection gate: postil/review explains findings, while postil/gate carries the required merge verdict.",
    socialDescription:
      "A merge gate and a review comment stream are different controls. Postil keeps them separate as postil/gate and postil/review.",
    excerpt:
      "Postil keeps advisory findings and the branch-protection verdict separate: postil/review explains, while postil/gate carries the required merge decision.",
  },
  {
    slug: "evidence-has-to-link-back",
    publishedOn: "2026-07-11",
    title: "Evidence has to link back",
    description:
      "Postil's public evidence examples link back to the source repository and the pull request files at the reviewed commit, with check-run artifacts retained in the data.",
    socialDescription:
      "Public AI review examples should resolve to the real PR state behind the claim, not a fictional demo.",
    excerpt:
      "Public AI review examples should resolve to the source repository, the reviewed pull request state, and the check-run records behind the claim.",
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
