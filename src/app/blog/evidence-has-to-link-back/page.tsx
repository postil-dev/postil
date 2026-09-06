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
          A review finding needs enough source material to test its claim. Postil&apos;s
          {" "}<Link href="/evidence">public examples</Link> retain the pull request, reviewed
          head commit, diff excerpt, finding text, and gate outcome together.
        </p>
        <EvidenceTrail />
        <h2>A documentation and CI finding</h2>
        <p>
          One published finding identifies <code>cli-ref</code> values that point to an action
          repository commit although that setting resolves against the CLI repository. The setting
          therefore resolves to a commit that does not exist in the target repository, which makes the
          CI installation fail. The diff excerpt and finding text expose the two repository identities
          behind that conclusion.
        </p>
        <p>
          The commit link opens that commit&apos;s own change view, not the complete pull-request review
          diff. A pull request can contain later commits, so its final diff can differ from the state
          that the reviewer saw. The evidence record identifies that reviewed state explicitly.
        </p>
        <h2>Finding text and merge outcome</h2>
        <p>
          Review text states the claimed defect. The retained gate record describes the conclusion
          published under the repository&apos;s <Link href="/docs/gate">gate rules</Link>. These records
          answer separate questions: whether the explanation fits the code, and what conclusion the
          configured policy produced.
        </p>
        <p>
          GitHub check-run pages can become unavailable, so those links do not independently establish
          an outcome. The <a href="https://github.com/postil-dev/postil/blob/main/src/data/evidence/index.ts">public source data</a>
          {" "}retains the displayed finding, commit reference, and gate record. A silent example
          records no visible finding; the <Link href="/bench">benchmark</Link> measures behaviour
          across a defined corpus.
        </p>
      </div>
    </div>
  );
}
