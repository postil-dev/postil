import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "The gate is separate from the review",
  description:
    "Postil splits advisory review output from the branch-protection gate: postil/review explains findings, while postil/gate carries the required merge verdict.",
  alternates: { canonical: "/blog/the-gate-is-separate-from-the-review" },
  openGraph: {
    type: "article",
    publishedTime: "2026-07-11T00:00:00.000Z",
    title: "The gate is separate from the review",
    description:
      "A merge gate and a review comment stream are different controls. Postil keeps them separate as postil/gate and postil/review.",
    url: "https://postil.dev/blog/the-gate-is-separate-from-the-review",
    images: ["/opengraph-image"],
  },
};

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline: "The gate is separate from the review",
  description:
    "Postil splits advisory review output from the branch-protection gate: postil/review explains findings, while postil/gate carries the required merge verdict.",
  url: "https://postil.dev/blog/the-gate-is-separate-from-the-review",
  datePublished: "2026-07-11",
  image: "https://postil.dev/opengraph-image",
  author: {
    "@type": "Organization",
    name: "Postil",
    url: "https://postil.dev",
  },
};

export default function GateSeparateFromReviewArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <p className="eyebrow">Blog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        The gate is separate from the review
      </h1>
      <p className="mt-4 font-mono text-sm text-charcoal/70">
        July 2026 · Postil team
      </p>

      <div className="prose-postil blog-prose mt-10">
        <p>
          A review and a gate sound similar until a branch protection rule has
          to make a decision. The review is the explanatory surface: findings,
          inline comments, summaries, and context for a human. The gate is the
          control surface: one required status check that either lets the head
          commit merge or blocks it. Postil exposes those as two GitHub
          check-runs, <code>postil/review</code> and <code>postil/gate</code>,
          because those jobs should not share one status.
        </p>

        <h2>One check cannot do both jobs cleanly</h2>
        <p>
          The <Link href="/docs/gate">gate documentation</Link> defines the
          split directly. <code>postil/gate</code> is the blocking verdict and
          the check teams require in branch protection. It fails when a finding
          reaches the configured threshold, whose default is{" "}
          <code>error</code>, or when the review cannot complete and the
          repository uses the default fail-closed behavior.{" "}
          <code>postil/review</code> carries advisory output and inline
          comments. The docs say not to require it.
        </p>
        <p>
          That separation matters because advisory output is allowed to be more
          expressive than a merge rule. A warning can be useful without being a
          blocker. A clean review can leave no visible comment while the passing
          check-run remains the record. An operational error can be visible in
          the advisory check without quietly turning an unreviewed head into a
          passing gate.
        </p>

        <h2>The required check is the product behavior</h2>
        <p>
          GitHub branch protection works on named status checks. If a team wants
          an AI reviewer to block merges, the enforceable artifact is the check
          that branch protection requires, not the presence of a comment. In
          Postil, that artifact is <code>postil/gate</code>. The homepage
          describes the same split, and the setup path in the docs tells teams
          to add <code>postil/gate</code> to required checks while leaving{" "}
          <code>postil/review</code> advisory.
        </p>
        <p>
          The <Link href="/evidence">evidence page</Link> shows the distinction
          in public examples. Each case is labeled by what the gate did:
          blocking, advising, or passing silently. The review content explains
          the finding when there is one. The gate state is the merge verdict.
          Those are related, but they are not the same artifact.
        </p>

        <h2>Why public evidence has to show the split</h2>
        <p>
          A product claim like &quot;blocks merges&quot; is only meaningful when
          the example shows which check carried the block and what source state
          it reviewed. The evidence-truthfulness work merged in{" "}
          <a
            href="https://github.com/postil-dev/postil/pull/321"
            rel="noopener"
          >
            postil-dev/postil#321
          </a>{" "}
          tightened the public examples around that rule: evidence cards now
          link to the source repository and to the pull request files at the
          reviewed commit. The evidence data also retains the reviewed head SHA
          and the review and gate check-run URLs as verification records.
        </p>
        <p>
          The standard is simple: advisory text can help a reviewer understand
          the issue, but the merge decision must be visible as its own required
          check. Postil keeps that boundary explicit so a team can require the
          gate without turning every advisory note into a blocker.
        </p>
      </div>
    </div>
  );
}
