import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
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
          A finding is useful when its explanation can be checked against the code it cites.
          In <a href="https://github.com/postil-dev/postil/pull/280#pullrequestreview-4617737950">this documentation review</a>,
          Postil flags a GitHub Actions example that uses one commit identifier for two different repositories.
          The example shows why a link to the reviewed revision matters, and what a retained gate result can establish.
        </p>
        <h2>One identifier, two repositories</h2>
        <p>
          The <a href="https://github.com/postil-dev/postil/blob/e625962b8890569c3eed4b48f893f7a5de43b60b/src/app/docs/quickstart/page.tsx#L69">reviewed quickstart</a>
          {" "}pins both <code>uses: postil-dev/postil-action@…</code> and <code>cli-ref</code> to the action repository&apos;s commit.
          These fields select different things: <code>uses</code> selects the action implementation;
          <code>cli-ref</code> selects the CLI source that the action installs.
        </p>
        <pre tabIndex={0} aria-label="Reviewed example with the wrong CLI repository commit">
          <code>{`uses: postil-dev/postil-action@0d92d604e753fd6831baeeff85e3f2ff4a84bd6c
with:
  cli-ref: 0d92d604e753fd6831baeeff85e3f2ff4a84bd6c`}</code>
        </pre>
        <p>
          The <a href="https://github.com/postil-dev/postil-action/blob/0d92d604e753fd6831baeeff85e3f2ff4a84bd6c/action.yml">action at that revision</a>
          {" "}defines <code>cli-ref</code> as a commit in <code>postil-dev/postil-cli</code> and passes it
          to <code>cargo install --git</code> for that repository. Copying an action commit into this
          field does not select the corresponding CLI version. The installer needs a commit that
          resolves in the CLI repository.
        </p>
        <p>
          The finding correctly identifies the repository mismatch and the field to correct.
          Its stronger claim, that installation fails, requires the referenced commit to be unavailable
          in the CLI repository. The retained example contains the review and source excerpt, not an
          installation log proving that failure. It supports the configuration diagnosis without
          establishing a reproduced CI failure.
        </p>
        <h2>The reviewed revision is the reference</h2>
        <p>
          The source link above opens the quickstart at the exact head commit named in the evidence record.
          A pull request&apos;s final diff can include fixes added after a review; using it to judge an
          earlier finding can make a correct report look wrong. A commit&apos;s change view has a different
          limitation: it shows that commit&apos;s changes, which need not include the whole pull-request diff.
          The retained record contains the reviewed head and an excerpt, but no review-base commit;
          it does not reconstruct the complete comparison.
        </p>
        <h2>A gate result records a policy decision</h2>
        <p>
          The <a href="/evidence/cli-ref-v1.json">retained record</a>
          {" "}contains two error-severity findings for the same copied identifier, one in the quickstart
          and one in the documentation index. It records a failing gate with <code>failOn: error</code>.
          That outcome is consistent with the stored severities and threshold. It does not independently
          verify either finding&apos;s diagnosis or prove that branch protection prevented a merge.
        </p>
        <p>
          The <Link href="/evidence">evidence page</Link> presents these stored records alongside their
          source links. When a GitHub check-run page is unavailable, the displayed outcome rests on
          Postil&apos;s retained copy. A reader can inspect the source code and the visible review, but
          cannot independently recover an unavailable check execution from that copy alone.
        </p>
      </div>
    </div>
  );
}
