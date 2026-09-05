import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { GateOutcomes } from "@/components/blog-figures";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("the-gate-is-separate-from-the-review");
export const metadata = blogPostMetadata(post);

export default function GateSeparateFromReviewArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd(post)) }} />
      <BlogArticleHeader post={post} />
      <div className="prose-postil blog-prose mt-10">
        <p>
          A warning can help a reviewer without stopping a merge. Postil separates the
          explanation from the merge decision: <code>postil/review</code> carries findings
          and inline comments, while <code>postil/gate</code> carries the enforcement result
          that a repository can require in branch protection.
        </p>
        <GateOutcomes />
        <h2>Choose what blocks</h2>
        <p>
          The default <code>gate.failOn</code> threshold is <code>error</code>. A warning below that
          threshold can appear in the advisory review while the gate passes. Finding kinds
          also matter: eligible <code>humanEscalation</code> findings block by default when
          their calibrated confidence reaches 0.30. The <Link href="/docs/gate">gate documentation</Link>{" "}
          describes the thresholds and approval rules.
        </p>
        <p>
          By default, a clean review provides its result through checks without an inline comment.
          On a blocking review, the finding explains the problem and the gate reports
          failure. Whether GitHub prevents a merge depends on the repository&apos;s branch
          protection or ruleset, including any configured bypass actors.
        </p>
        <h2>Require the gate in GitHub</h2>
        <p>
          After Postil has reviewed a pull request, add <code>postil/gate</code> to the
          required status checks and bind its source to the Postil GitHub App. Leave{" "}
          <code>postil/review</code> advisory. GitHub&apos;s <a href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches">protected-branch guide</a>{" "}
          explains how required checks and bypass permissions affect merging.
        </p>
        <h2>An incomplete review needs an explicit policy</h2>
        <p>
          Postil fails closed by default when a review cannot complete. A timeout or
          unusable model response must not look like a clean review. Re-request the check
          after correcting the failure.
        </p>
        <p>
          Setting <code>gate.onError: advisory</code> permits merging on provider
          errors, such as a provider outage. The hosted check reports a neutral result
          when the review is unavailable under that policy; it also reports neutral when
          gating is disabled. GitHub accepts neutral required checks. This setting does not exempt invalid model output or
          blocking findings. Choose that setting only if the repository can accept an
          unreviewed change during a provider failure.
        </p>
        <p>
          Compare the <Link href="/evidence">blocking, advisory, and silent examples</Link>{" "}
          to see how the same pair of checks represents each outcome.
        </p>
      </div>
    </div>
  );
}
