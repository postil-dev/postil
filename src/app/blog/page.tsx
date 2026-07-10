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
    images: ["/opengraph-image"],
  },
};

const POSTS = [
  {
    href: "/blog/silence-rate",
    date: "June 2026",
    title: "The silence rate: an ongoing AI code review metric",
    description:
      "GitHub published a one-off Copilot silence figure. Postil makes silence rate an ongoing per-organization metric: how often the tool says nothing.",
  },
  {
    href: "/blog/where-does-your-code-go",
    date: "June 2026",
    title:
      "Where does your code actually go? A data-flow audit of AI code review tools",
    description:
      "AI reviewers differ less on what they find than on where your code goes, who keeps it, and whether it trains a model. A class-by-class audit of retention, training, and inference location.",
  },
  {
    href: "/blog/self-hosted-ai-code-review",
    date: "July 2026",
    title:
      "Self-hosted AI code review without the 500-seat enterprise gate",
    description:
      "CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer it at all. Run an Apache-2.0 reviewer locally with Ollama, with no seat fees or license cost.",
  },
  {
    href: "/blog/ai-code-review-benchmarks",
    date: "July 2026",
    title:
      "Four AI code review benchmarks, four home-team winners",
    description:
      "Greptile scored 82% on its own benchmark and 45% when a rival re-ran it. Why vendor code-review benchmarks can't be trusted at face value, and a five-point test for spotting a rigged one.",
  },
  {
    href: "/blog/why-copilot-cant-block-your-merge",
    date: "July 2026",
    title:
      "Why GitHub Copilot can't block your merge (and how a real AI merge gate works)",
    description:
      "Branch protection blocks on required status checks that conclude failure, not on review comments or neutral checks. Copilot posts a Comment, Claude Code review concludes neutral, and Macroscope defaults neutral unless configured to fail.",
  },
  {
    href: "/blog/ai-code-review-pricing-2026",
    date: "July 2026",
    title:
      "AI code review pricing in 2026: what a 20-developer team actually pays",
    description:
      "Four vendors changed pricing models in ninety days. We run the same 20-developer team through seven tools, assumptions stated, arithmetic shown, every price sourced.",
  },
  {
    href: "/blog/best-ai-code-review-tools-2026",
    date: "July 2026",
    title: "Best AI code review tools in 2026: an evidence-first comparison",
    description:
      "CodeRabbit, Qodo, Macroscope, Greptile, Copilot, Bugbot, and Postil, compared on noise, merge gating, self-hosting, data handling, and a pricing landscape that changed four times in ninety days. Every claim sourced.",
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
        linked, competitors compared on the record, publishing fewer claims and
        keeping them accurate.
      </p>

      <div className="mt-14 space-y-6">
        {POSTS.map((post) => (
          <Link
            key={post.href}
            href={post.href}
            className="card block p-7 transition-colors hover:border-gate"
          >
            <p className="font-mono text-xs text-charcoal/70">{post.date}</p>
            <h2 className="serif-display mt-2 text-2xl">{post.title}</h2>
            <p className="mt-3 text-sm text-ink-soft">{post.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
