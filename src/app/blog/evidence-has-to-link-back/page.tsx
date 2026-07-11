import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Evidence has to link back",
  description:
    "Postil's public evidence examples link back to the source repository and the pull request files at the reviewed commit, with check-run artifacts retained in the data.",
  alternates: { canonical: "/blog/evidence-has-to-link-back" },
  openGraph: {
    type: "article",
    publishedTime: "2026-07-11T00:00:00.000Z",
    title: "Evidence has to link back",
    description:
      "Public AI review examples should resolve to the real PR state behind the claim, not a fictional demo.",
    url: "https://postil.dev/blog/evidence-has-to-link-back",
    images: ["/opengraph-image"],
  },
};

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline: "Evidence has to link back",
  description:
    "Postil's public evidence examples link back to the source repository and the pull request files at the reviewed commit, with check-run artifacts retained in the data.",
  url: "https://postil.dev/blog/evidence-has-to-link-back",
  datePublished: "2026-07-11",
  image: "https://postil.dev/opengraph-image",
  author: {
    "@type": "Organization",
    name: "Postil",
    url: "https://postil.dev",
  },
};

export default function EvidenceLinksArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <p className="eyebrow">Blog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Evidence has to link back
      </h1>
      <p className="mt-4 font-mono text-sm text-charcoal/70">
        July 2026 · Postil team
      </p>

      <div className="prose-postil blog-prose mt-10">
        <p>
          Evidence for an AI code reviewer should be inspectable, not just
          persuasive. A screenshot or polished demo can show what a product
          looks like, but it cannot answer the practical question: what code was
          reviewed, at what state, and where is the artifact that produced the
          claim? Postil&apos;s public <Link href="/evidence">evidence page</Link>{" "}
          is built around real review output from public Postil repositories, so
          the examples can link back to source.
        </p>

        <h2>The pull request is not a fixed object</h2>
        <p>
          A pull request changes over time. New commits arrive, force-pushes
          replace history, conversations move, and the final merge state may not
          be the same state a reviewer saw. That is why a useful evidence link
          has to point at the reviewed commit, not only at the PR conversation.
        </p>
        <p>
          The work merged in{" "}
          <a
            href="https://github.com/postil-dev/postil/pull/321"
            rel="noopener"
          >
            postil-dev/postil#321
          </a>{" "}
          added that breadcrumb to the evidence UI. Each evidence card exposes a
          repository link and a pull-request-files link scoped to the reviewed
          commit SHA. PR #321 is merged into <code>main</code>; its merge commit
          is{" "}
          <a
            href="https://github.com/postil-dev/postil/commit/1b9182c262e55609a60a4723b2c5bd1f74651c1b"
            rel="noopener"
          >
            <code>1b9182c262e55609a60a4723b2c5bd1f74651c1b</code>
          </a>
          .
        </p>

        <h2>The data keeps the verification record</h2>
        <p>
          The public evidence data is in{" "}
          <a
            href="https://github.com/postil-dev/postil/blob/main/src/data/evidence/index.ts"
            rel="noopener"
          >
            <code>src/data/evidence/index.ts</code>
          </a>
          . The file documents the rule it follows: public examples come from
          Postil&apos;s public repositories; finding titles and bodies are copied
          from check-run annotations; review and gate titles and summaries are
          copied from their check-runs; check-run IDs and the reviewed head SHA
          are retained as the verification record.
        </p>
        <p>
          The page does not rely on invented sample PRs for those cases. Its UI
          shows the reviewed diff excerpt or complete diff, the finding text
          Postil produced, and the gate outcome for the reviewed commit. For
          silent reviews, the evidence case links a pull request where Postil
          left no visible review comment.
        </p>

        <h2>Truthful links are part of the claim</h2>
        <p>
          Evidence links also keep the gate and review boundary honest. If a
          case says the gate failed, the source data has a gate check-run URL and
          a <code>gate.failing</code> value. If a case says the review advised
          without blocking, the findings live in the advisory review output
          while the gate remains passing. If a case says the review was silent,
          the public PR has no visible Postil review comment.
        </p>
        <p>
          Some GitHub check-run pages can become unavailable in the UI after
          GitHub&apos;s retention window. Postil still keeps the reviewed head
          SHA and check-run URLs in the evidence data, while the visible page
          links to the repository and the PR files at the reviewed commit. That
          is the durable part of the public claim: readers can inspect the code
          state the example refers to instead of trusting a fictional demo.
        </p>
      </div>
    </div>
  );
}
