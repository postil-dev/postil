import Link from "next/link";

import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("evidence-has-to-link-back");
export const metadata = blogPostMetadata(post);
const articleJsonLd = blogPostJsonLd(post);

export default function EvidenceLinksArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <BlogArticleHeader post={post} />

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
          Each evidence card exposes a repository link and a pull-request-files
          link scoped to the reviewed commit SHA. The link therefore remains
          tied to the exact source state behind the review claim.
        </p>

        <h2>The data keeps the verification record</h2>
        <p>
          Public examples come from Postil&apos;s public repositories. Finding
          titles and bodies match check-run annotations; review and gate titles
          and summaries match their check-runs; check-run IDs and the reviewed
          head SHA remain part of the verification record.
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
