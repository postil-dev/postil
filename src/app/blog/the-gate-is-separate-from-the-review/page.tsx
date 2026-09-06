import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
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
          A warning can deserve a developer&apos;s attention without stopping a merge.
          Postil publishes findings through <code>postil/review</code> and the policy decision through
          {" "}<code>postil/gate</code>. In blocking mode, a completed review with one ordinary warning
          and no blocking findings passes an error-only gate while the warning remains visible.
        </p>
        <h2>What makes a finding block a merge?</h2>
        <p>
          New hosted organizations use advisory mode: <code>postil/gate</code> concludes neutral,
          including when a review fails to complete. An organization admin enables blocking in settings.
          That setting lets Postil publish a failing gate; GitHub enforces it only when the branch&apos;s
          protection rule or ruleset requires <code>postil/gate</code>.
        </p>
        <p>
          Bind the required check to the Postil GitHub App so another integration cannot satisfy it by
          publishing the same check name. <a href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches">GitHub branch protection</a>
          {" "}also controls bypass permissions. Enabling blocking in Postil does not remove those permissions.
        </p>
        <h2>Severity and findings that require human judgment</h2>
        <p>
          In blocking mode, <code>gate.failOn: error</code> is the default severity threshold.
          An error fails the gate; an ordinary warning does not. Setting <code>gate.failOn: warn</code>
          {" "}makes warnings fail it too. The review still displays the findings in each case.
        </p>
        <p>
          Some findings ask for human judgment and carry the kind <code>humanEscalation</code>.
          This kind can block independently of severity: by default it blocks when the finding&apos;s
          calibrated confidence score reaches 0.30. A warning with this kind and a score of 0.40
          therefore fails an error-only gate. The score is an input to the gate rule, not a guarantee
          that the finding is correct. The <Link href="/docs/gate">gate documentation</Link> describes
          the thresholds and the approval rules for eligible judgment calls.
        </p>
        <h2>What happens when the provider fails?</h2>
        <p>
          Blocking mode defaults to <code>gate.onError: block</code>. An incomplete review fails the gate.
          A repository can instead make provider failures produce a neutral gate when no other
          condition requires failure. A neutral conclusion satisfies GitHub&apos;s requirement for
          this check, so Postil does not prevent a merge despite the incomplete review. Other
          required checks and branch rules still apply. Set the exception in <code>.postil.yaml</code>:
        </p>
        <pre tabIndex={0} aria-label="Gate configuration permitting provider failures">
          <code>{`gate:
  failOn: error
  onError: advisory`}</code>
        </pre>
        <p>
          This exception covers provider outages and connection timeouts. Invalid model output that still fails
          validation after a retry remains a gate failure. Findings that already meet a blocking rule
          also continue to fail the gate.
        </p>
        <div className="overflow-x-auto">
          <table>
            <caption>Gate conclusions with organization blocking enabled and the default error threshold</caption>
            <thead><tr><th scope="col">Review outcome</th><th scope="col">Default policy</th><th scope="col">Provider errors advisory</th></tr></thead>
            <tbody>
              <tr><th scope="row">Completed, no blocking findings</th><td>Success</td><td>Success</td></tr>
              <tr><th scope="row">Blocking finding</th><td>Failure</td><td>Failure</td></tr>
              <tr><th scope="row">Provider unavailable, no other blocking condition</th><td>Failure</td><td>Neutral</td></tr>
              <tr><th scope="row">Model output invalid after retry</th><td>Failure</td><td>Failure</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
