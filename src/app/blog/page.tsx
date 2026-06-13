import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Research notes on AI code review: evidence-first tool comparisons, pricing analysis, and the metrics vendors don't publish.",
  alternates: { canonical: "/blog" },
  openGraph: {
    title: "Postil blog",
    description:
      "Research notes on AI code review: evidence-first comparisons and the metrics vendors don't publish.",
    url: "https://postil.dev/blog",
  },
};

const POSTS = [
  {
    href: "/blog/ai-code-review-pricing-2026",
    date: "June 2026",
    title:
      "AI code review pricing in 2026: what a 20-developer team actually pays",
    description:
      "Four vendors changed pricing models in ninety days. We run the same 20-developer team through seven tools, assumptions stated, arithmetic shown, every price dated and sourced.",
  },
  {
    href: "/blog/best-ai-code-review-tools-2026",
    date: "June 2026",
    title: "Best AI code review tools in 2026: an evidence-first comparison",
    description:
      "CodeRabbit, Qodo, Macroscope, Greptile, Copilot, Bugbot, and Postil, compared on noise, merge gating, self-hosting, data handling, and a pricing landscape that changed four times in ninety days. Every claim dated and sourced.",
  },
  {
    href: "/blog/silence-rate",
    date: "June 2026",
    title: "The silence rate: the AI code review metric nobody publishes",
    description:
      "Developers stop reading AI reviewers that are wrong a third of the time. The metric that predicts it is the one no vendor benchmark reports: how often the tool says nothing.",
  },
] as const;

export default function BlogIndexPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <p className="eyebrow">Blog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Research notes.
      </h1>
      <p className="mt-6 text-lg text-ink-soft">
        Writing about AI code review the way we build it: claims dated, sources
        linked, competitors compared on the record. We say less. What we say is
        right.
      </p>

      <div className="mt-14 space-y-6">
        {POSTS.map((post) => (
          <Link
            key={post.href}
            href={post.href}
            className="card block p-7 transition-colors hover:border-gate"
          >
            <p className="font-mono text-xs text-charcoal/60">{post.date}</p>
            <h2 className="serif-display mt-2 text-2xl">{post.title}</h2>
            <p className="mt-3 text-sm text-ink-soft">{post.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
