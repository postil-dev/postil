import Link from "next/link";

import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("why-copilot-cant-block-your-merge");
export const metadata = blogPostMetadata(post);
const articleJsonLd = blogPostJsonLd(post);

export default function CopilotMergeGateArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <BlogArticleHeader post={post} />

      <div className="prose-postil blog-prose mt-10">
        <p>
          A common assumption about AI code review is that turning it on adds a
          safety interlock: if the reviewer dislikes a change, the change
          can&apos;t merge. For most of the tools in this category that is not
          how it works, and the reason is not a missing feature or a pricing
          tier. It is the GitHub merge mechanics. A reviewer that posts a
          comment, or completes a check with a neutral result, is structurally
          incapable of stopping a merge no matter how confident it is. This is a
          mechanics explainer: what GitHub actually blocks on, why a
          comment-only or neutral reviewer slips past it, and how a real gate is
          built. The Postil-specific parts are backed by the open behavior in
          our CLI source rather than by marketing.
        </p>

        <h2>Three different things GitHub calls &quot;review&quot;</h2>
        <p>
          Branch protection on GitHub has two independent levers that people
          conflate, plus a third state that quietly defeats both.
        </p>
        <ul>
          <li>
            <strong>Required pull request reviews.</strong> A protected branch
            can require N approving reviews. A review is an event with one of
            three states: <code>APPROVE</code>, <code>REQUEST_CHANGES</code>, or
            <code> COMMENT</code>. Only <code>APPROVE</code> counts toward the
            required count, and only <code>REQUEST_CHANGES</code> actively holds
            a merge open until dismissed. A <code>COMMENT</code> review is
            inert: it neither approves nor blocks.
          </li>
          <li>
            <strong>Required status checks.</strong> A protected branch can
            require named checks to be green before merge. Each check run reports
            a <code>conclusion</code>: <code>success</code>, <code>failure</code>
            , <code>neutral</code>, <code>cancelled</code>, and so on. Branch
            protection blocks the merge only while a required check is missing or
            its conclusion is one of the failing values. This is the lever that
            actually enforces.
          </li>
          <li>
            <strong>The neutral conclusion.</strong> A check that completes with
            <code> neutral</code> renders as a grey square, not a red X. Crucially,
            branch protection treats neutral as <em>not failing</em>. A required
            check that always concludes neutral will never block anything; it
            satisfies the &quot;check has reported&quot; requirement and then
            reports a non-failure.
          </li>
        </ul>
        <p>
          So there is exactly one way for an automated reviewer to gate a merge
          on GitHub: it must publish a status check, that check must be marked
          required in branch protection, and it must be willing to conclude{" "}
          <code>failure</code>. A reviewer that only leaves comments has opted
          out of the enforcement lever entirely. A reviewer that publishes a
          check but only ever concludes neutral has wired up the lever and then
          disconnected it.
        </p>

        <h2>Where the surveyed tools land</h2>
        <p>
          With that mechanic in hand, the behavior of the common tools is
          unsurprising.
        </p>
        <p>
          <strong>GitHub Copilot code review posts a Comment.</strong>{" "}
          According to{" "}
          <a
            href="https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review"
            rel="noopener"
          >
            GitHub&apos;s own documentation
          </a>
          , Copilot&apos;s review is left as a Comment and does not count toward
          required approvals. It is on the first lever (reviews) but in the one
          state that neither approves nor requests changes. There is no setting
          that promotes it to a required, blocking check, which is why
          enterprises asking for enforcement remain an{" "}
          <a
            href="https://github.com/orgs/community/discussions/184163"
            rel="noopener"
          >
            open community thread
          </a>
          . This is not Copilot being weak; it is Copilot choosing the inert
          review state by design.
        </p>
        <p>
          <strong>
            Claude Code review concludes neutral; Macroscope defaults neutral.
          </strong>{" "}
          Both publish status checks rather than comments, which looks like the
          enforcement path. But{" "}
          <a href="https://code.claude.com/docs/en/code-review" rel="noopener">
            Claude Code review&apos;s documentation
          </a>{" "}
          states its check completes with a neutral conclusion.{" "}
          <a
            href="https://docs.macroscope.com/check-run-agents"
            rel="noopener"
          >
            Macroscope Check Run Agents
          </a>
          default to a neutral ceiling, while{" "}
          <a href="https://docs.macroscope.com/approvability" rel="noopener">
            Macroscope Approvability
          </a>{" "}
          documents how to configure a failure conclusion as a required status
          check. So Macroscope is configurable: left at its neutral default, the
          check exists and the gate does not; configured to fail, it can block a
          merge.
        </p>
        <p>
          <strong>
            Among the surveyed tools, Cursor Bugbot offers a real required
            check.
          </strong>{" "}
          Per{" "}
          <a href="https://cursor.com/docs/bugbot" rel="noopener">
            its documentation
          </a>
          , Bugbot publishes a CI check with success and failure conclusions that
          branch protection can require. That is the architecture that actually
          enforces. We mention it precisely because it shows the difference is a
          design decision about conclusions and required checks, not a limit of
          what AI reviewers can technically do on GitHub.
        </p>

        <h2>Why this matters more as agents write more code</h2>
        <p>
          The gap between advisory and enforcing is the gap between feedback and
          a control. Integration guidance has been blunt about it:{" "}
          <a
            href="https://www.augmentcode.com/guides/ai-agent-pre-merge-verification"
            rel="noopener"
          >
            &quot;verification that is recommended but not enforced in CI gets
            bypassed under pressure.&quot;
          </a>{" "}
          A reviewer that can only comment is a recommendation. When most of the
          diffs arriving in a repository are machine-generated and the human in
          the loop is approving at volume, &quot;a bot left a comment&quot; is
          not a control surface. The recommended architecture in neutral guides
          is to keep the chatty, explanatory feedback as advisory and put a
          separate, severity-thresholded{" "}
          <a href="https://techsy.io/en/blog/ai-code-review-guide" rel="noopener">
            required status check in front of the merge
          </a>{" "}
          so that the AI finds and explains while the check enforces.
        </p>

        <h2>How Postil&apos;s two-check model works</h2>
        <p>
          Postil splits the two roles into two distinct GitHub check runs,
          created on every reviewed commit:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`postil/review: reviewer verdict and advisory findings
postil/gate: organization merge policy`}</code>
        </pre>
        <p>
          <code>postil/review</code> is the advisory check. It carries the
          summary and the inline finding annotations: the explanatory feedback,
          the part you read. <code>postil/gate</code> is the enforcing check.
          It carries the merge decision and nothing else. You mark{" "}
          <code>postil/gate</code> as required in branch protection; you leave{" "}
          <code>postil/review</code> advisory. The split exists so that the
          enforcement signal is never diluted by the volume of advisory
          commentary.
        </p>
        <p>The hosted service maps the two terminal outcomes independently:</p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`completed review: postil/review = success
review execution failed: postil/review = neutral
blocking finding: postil/gate = failure
review execution failed: postil/gate = organization policy`}</code>
        </pre>
        <p>
          A completed review can contain blocking findings, so a successful{" "}
          <code>postil/review</code> means the reviewer ran, not that the change
          passed the gate. Findings at or above the configured{" "}
          <code>failOn</code> severity make <code>postil/gate</code> fail. When
          hosted execution stops before producing a verdict, the run status is
          failed and <code>postil/review</code> completes neutral with an
          explicit no-verdict result. The gate applies the organization&apos;s
          merge-gate setting separately.
        </p>

        <h2>Execution failures remain explicit</h2>
        <p>
          The dangerous failure mode for a merge gate is the silent pass: the
          reviewer errors out, reports nothing alarming, and the merge proceeds
          as if it had been checked. Postil records that run as failed, leaves{" "}
          <code>postil/review</code> neutral because no reviewer verdict exists,
          and gives the gate an explicit policy outcome.
        </p>
        <p>
          New organizations start with an advisory merge gate, so an execution
          failure leaves <code>postil/gate</code> neutral. An organization admin
          can enable merge enforcement after adding the check to branch
          protection; under enforcement, the same no-verdict run makes the gate
          fail. Completed reviews continue to use the repository&apos;s{" "}
          <code>failOn</code> threshold. <code>postil/gate</code> is the check
          whose conclusion carries the merge policy branch protection reads.
        </p>

        <h2>Adopt the gate without surprises: postil plan</h2>
        <p>
          The honest objection to any required check is that you can&apos;t see
          what it will block until it blocks something, and a gate that fails
          your merge queue on day one is its own kind of noise. Postil&apos;s
          answer is <code>postil plan</code>, a config dry-run. It replays your
          stored past reviews under a candidate configuration and reports what
          would change, without posting anything or blocking anything:
        </p>
        <p>
          The command reports before and after finding counts for each stored
          envelope, which findings the candidate config would suppress, and
          every gate outcome that would change. You see the gate flips before
          you arm the gate. The recommended
          adoption path is the one the integration guides describe: run{" "}
          <code>postil/gate</code> advisory for a couple of weeks, use{" "}
          <code>postil plan</code> to tune <code>failOn</code> until the gate
          flips only on changes you would genuinely hold, and only then mark the
          check required in branch protection. The dry-run is what lets that be a
          measured decision instead of a leap.
        </p>

        <h2>The short version</h2>
        <p>
          GitHub blocks merges on required status checks that conclude failure,
          not on review comments and not on neutral checks. A reviewer that posts
          a Comment (Copilot) or concludes neutral (Claude Code review, or any
          default-neutral check) has chosen, by design, a signal that branch
          protection will not enforce. A real gate is one check run that is
          willing to conclude failure, marked required, kept separate from the
          advisory chatter, and willing to fail when merge enforcement is
          enabled. You can{" "}
          <Link href="/docs/gate">read how the gate is configured</Link>, dry-run
          it with <code>postil plan</code> before arming it, or{" "}
          <Link href="/evidence">see a review run</Link> end to end first.
        </p>

        <h2>Sources</h2>
        <ul>
          <li>
            <a
              href="https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review"
              rel="noopener"
            >
              GitHub docs: Copilot code review (posts a Comment, does not count
              toward required approvals)
            </a>
          </li>
          <li>
            <a
              href="https://github.com/orgs/community/discussions/184163"
              rel="noopener"
            >
              GitHub community discussion: requesting Copilot review enforcement
            </a>
          </li>
          <li>
            <a href="https://code.claude.com/docs/en/code-review" rel="noopener">
              Claude Code review docs (check completes with a neutral conclusion)
            </a>
          </li>
          <li>
            <a
              href="https://docs.macroscope.com/check-run-agents"
              rel="noopener"
            >
              Macroscope Check Run Agents docs (neutral by default, configurable
              to failure)
            </a>
          </li>
          <li>
            <a href="https://docs.macroscope.com/approvability" rel="noopener">
              Macroscope Approvability docs (required failing status-check
              configuration)
            </a>
          </li>
          <li>
            <a href="https://cursor.com/docs/bugbot" rel="noopener">
              Cursor Bugbot docs (CI check with success/failure conclusions that
              branch protection can require)
            </a>
          </li>
          <li>
            <a
              href="https://www.augmentcode.com/guides/ai-agent-pre-merge-verification"
              rel="noopener"
            >
              Augment: pre-merge verification (unenforced verification gets
              bypassed)
            </a>
          </li>
          <li>
            <a
              href="https://techsy.io/en/blog/ai-code-review-guide"
              rel="noopener"
            >
              techsy.io: AI code review guide (severity-gated required checks as
              the enforcement point)
            </a>
          </li>
        </ul>
      </div>

      <div className="rounded-card shadow-card mt-14 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">A required check that can fail.</h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            postil/gate carries organization merge policy for completed reviews
            and execution failures. Dry-run repository thresholds with postil
            plan before you arm it.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
          <Link href="/install" className="btn-primary text-center">
            Install the CLI
          </Link>
          <Link
            href="/docs/gate"
            className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-center text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
          >
            Read the gate docs
          </Link>
        </div>
      </div>
    </div>
  );
}
