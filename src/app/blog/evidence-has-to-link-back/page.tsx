import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { EvidenceTrail } from "@/components/blog-figures";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("evidence-has-to-link-back");
export const metadata = blogPostMetadata(post);

export default function EvidenceLinksArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd(post)) }} />
      <BlogArticleHeader post={post} />
      <div className="prose-postil blog-prose mt-10">
        <p>
          To assess an AI review finding, open the code it refers to. Check the cited line,
          read the surrounding change, and decide whether the claimed failure follows.
          Postil&apos;s <Link href="/evidence">public examples</Link> pair review output with
          links to the source pull request so you can make that assessment yourself.
        </p>
        <EvidenceTrail />
        <h2>Inspect the code the reviewer saw</h2>
        <p>
          A pull request can contain several revisions. Its final diff may include a fix
          that is absent from the reviewed revision. The revision link selects the
          reviewed commit&apos;s changes. Compare those with the example&apos;s displayed diff:
          a pull-request review can cover more than one commit. The conversation alone may
          describe a different state of the code.
        </p>
        <p>
          A finding should identify its location and explain a consequence. Ask whether
          the surrounding control flow supports that explanation and whether relevant
          checks exist elsewhere. A plausible comment is a claim to investigate, not proof
          that a bug exists.
        </p>
        <h2>Read the verdict separately</h2>
        <p>
          Review text explains the issue. The gate result records whether it blocks under
          the repository&apos;s rules. An advisory warning and a blocking error can both
          be useful findings, but they have different effects on a merge. Inspect the
          verdict for the same reviewed commit, using the <Link href="/docs/gate">gate rules</Link>{" "}
          to interpret it.
        </p>
        <p>
          A silent example shows a review without visible findings. It does not establish
          that the code is defect-free. Likewise, a published example demonstrates one
          review outcome; it does not measure the reviewer&apos;s detection rate across a
          codebase. The <Link href="/bench">benchmark</Link> addresses that separate question
          on a defined test corpus.
        </p>
        <h2>Know what the record preserves</h2>
        <p>
          The evidence page includes diff excerpts, finding text, and gate outcomes.
          Its <a href="https://github.com/postil-dev/postil/blob/main/src/data/evidence/index.ts">public source data</a>{" "}
          retains the reviewed commit and check-run references. If an upstream check page
          is unavailable, the retained text remains a published record, but the missing
          page limits independent verification. A code link verifies the input; it cannot
          by itself verify what a reviewer said about it.
        </p>
      </div>
    </div>
  );
}
