import type { Metadata } from "next";
import Link from "next/link";

import { formatBlogPublicationDate, orderedBlogPosts } from "@/lib/blog-posts";

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

export default function BlogIndexPage() {
  const posts = orderedBlogPosts();
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
        {posts.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="card block p-7 transition-colors hover:border-gate"
          >
            <time
              dateTime={post.publishedOn}
              className="font-mono text-xs text-charcoal/70"
            >
              {formatBlogPublicationDate(post.publishedOn)}
            </time>
            <h2 className="serif-display mt-2 text-2xl">{post.title}</h2>
            <p className="mt-3 text-sm text-ink-soft">{post.excerpt}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
