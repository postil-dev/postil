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
          <code>postil/review</code> publishes findings and inline comments. <code>postil/gate</code>{" "}
          publishes the organization&apos;s gate conclusion. A warning can remain visible in the review
          while the gate succeeds.
        </p>
        <GateOutcomes />
        <h2>From advisory to required</h2>
        <p>
          New hosted organizations publish <code>postil/gate</code> as advisory. An organization
          admin enables blocking in settings. While the organization mode is advisory, the gate check
          concludes neutral for normal reviews, operational failures, and finding-decision changes;
          no finding blocks a merge through that check.
        </p>
        <p>
          With blocking enabled, the default threshold is <code>gate.failOn: error</code>. A warning
          below that threshold leaves <code>postil/gate</code> successful. A
          {" "}<code>humanEscalation</code> finding with calibrated confidence of at least 0.30
          blocks by default. These thresholds are separate from organization gate mode.
        </p>
        <p>
          After blocking is enabled, a branch rule can require <code>postil/gate</code> and bind that
          check to the Postil GitHub App. <code>postil/review</code> remains advisory. GitHub branch
          protection and rulesets determine whether a failing gate blocks a merge, including any
          configured bypass actors.
        </p>
        <h2>Provider failure policy</h2>
        <pre tabIndex={0} aria-label="Gate configuration example">
          <code>{`gate:
  failOn: error
  onError: advisory`}</code>
        </pre>
        <p>
          With blocking enabled, <code>gate.onError: block</code> is the default: an incomplete review
          fails closed. The configuration shown above changes provider failures to a neutral gate
          conclusion. GitHub accepts neutral required checks. It does not convert invalid model output
          or existing blocking findings into a passing outcome. The
          {" "}<Link href="/docs/gate">gate documentation</Link> specifies these outcomes.
        </p>
      </div>
    </div>
  );
}
