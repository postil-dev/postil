import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title:
    "Why GitHub Copilot can't block your merge (and how a real AI merge gate works)",
  description:
    "GitHub branch protection blocks on required status checks, not on review comments. Copilot code review posts a Comment, Claude Code review concludes neutral, and Macroscope defaults to neutral checks unless configured to fail.",
  alternates: { canonical: "/blog/why-copilot-cant-block-your-merge" },
  openGraph: {
    type: "article",
    publishedTime: "2026-07-08T00:00:00.000Z",
    title:
      "Why GitHub Copilot can't block your merge (and how a real AI merge gate works)",
    description:
      "Branch protection blocks on required status checks, not review comments. A Comment-only or neutral-concluding reviewer cannot gate a merge. Here is the mechanic.",
    url: "https://postil.dev/blog/why-copilot-cant-block-your-merge",
    images: ["/opengraph-image"],
  },
};

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline:
    "Why GitHub Copilot can't block your merge (and how a real AI merge gate works)",
  description:
    "GitHub branch protection blocks on required status checks, not review comments. Copilot code review posts a Comment, Claude Code review concludes neutral, and Macroscope defaults to neutral checks unless configured to fail.",
  url: "https://postil.dev/blog/why-copilot-cant-block-your-merge",
  datePublished: "2026-07-08",
  image: "https://postil.dev/opengraph-image",
  author: {
    "@type": "Organization",
    name: "Postil",
    url: "https://postil.dev",
  },
};

export default function CopilotMergeGateArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <p className="eyebrow">Blog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Why GitHub Copilot can&apos;t block your merge (and how a real AI merge
        gate works)
      </h1>
      <p className="mt-4 font-mono text-sm text-charcoal/70">
        July 2026 · Postil team
      </p>

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
          created on every reviewed commit. The backing for what follows is the{" "}
          <a
            href="https://github.com/postil-dev/postil-cli/blob/main/src/forge/github.rs"
            rel="noopener"
          >
            postil-cli source
          </a>
          : the checks are created in <code>start_checks</code> and their
          conclusions are written in <code>complete_checks</code>.
        </p>
        <p>
          The CLI opens both checks <code>in_progress</code> at the start of a
          review:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`for name in ["postil/review", "postil/gate"] {
    // POST /check-runs  { name, head_sha, status: "in_progress" }
}`}</code>
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
        <p>
          The conclusions are not interchangeable, and the design rule is
          written directly into the source. The doc comment on the{" "}
          <code>CheckState</code> enum in <code>src/forge/mod.rs</code> states the
          contract:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`/// Check conclusions, mapped per-forge. Postil semantics:
/// - advisory check (\`postil/review\`): success unless the run itself failed.
/// - gate check (\`postil/gate\`): failure iff gate-level findings exist (or the
///   run failed — fail closed). Never \`neutral\` for the gate: a grey square
///   that reads as "didn't fail" is the GitHub Copilot mistake.`}</code>
        </pre>
        <p>
          That last sentence is the whole article in one line, and it is in the
          shipping code, not a slide. The gate check is only ever{" "}
          <code>success</code> or <code>failure</code>. It is structurally not
          allowed to take the neutral conclusion that makes Claude Code review
          and default-neutral checks non-blocking. The conclusion is computed
          straight from the gate outcome:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`let gate_state = if envelope.gate.failing {
    CheckState::Failure
} else {
    CheckState::Success
};`}</code>
        </pre>
        <p>
          Whether the gate is failing is itself a policy decision you control:
          findings at or above your configured <code>failOn</code> severity flip{" "}
          <code>gate.failing</code> to true. The advisory check, by contrast, can
          go neutral, but only to surface an operational problem. When the
          review itself hits an operational error (a provider outage, unusable
          model output) the advisory check goes neutral so an outage does not
          masquerade as a clean pass, while the gate makes its own call
          separately.
        </p>

        <h2>The gate fails closed on error</h2>
        <p>
          The dangerous failure mode for a merge gate is the silent pass: the
          reviewer errors out, reports nothing alarming, and the merge proceeds
          as if it had been checked. Postil&apos;s default is the opposite. When
          a run errors, the gate concludes <code>failure</code> rather than
          standing aside:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`let gate_state = match cfg.gate_on_error {
    OnError::Block => CheckState::Failure,   // default: fail closed
    OnError::Advisory => CheckState::Success,
};`}</code>
        </pre>
        <p>
          By default <code>gate.onError</code> is <code>block</code>: an errored
          run blocks the merge. A repository can opt into{" "}
          <code>onError: advisory</code> so a provider blip does not freeze every
          merge, in which case the gate stands aside but the advisory check still
          goes neutral to show the error. The source comment names the constraint
          that keeps this honest: unusable model output never bypasses the gate,
          because a malicious diff could otherwise induce that error via prompt
          injection to slip past review. Either way the gate is binary on the
          merge decision and never neutral. That is the difference between
          &quot;the check didn&apos;t fail&quot; and &quot;the check passed,&quot;
          and it is the difference branch protection actually reads.
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
          advisory chatter, and failing closed on error. You can{" "}
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
          <li>
            Postil mechanics:{" "}
            <a
              href="https://github.com/postil-dev/postil-cli/blob/main/src/forge/mod.rs"
              rel="noopener"
            >
              src/forge/mod.rs
            </a>{" "}
            (CheckState contract),{" "}
            <a
              href="https://github.com/postil-dev/postil-cli/blob/main/src/forge/github.rs"
              rel="noopener"
            >
              src/forge/github.rs
            </a>{" "}
            (check-run creation and conclusions)
          </li>
        </ul>
      </div>

      <div className="rounded-card shadow-card mt-14 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">A required check that can fail.</h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            postil/gate is a required check that concludes failure on
            gate-level findings and fails closed on error. Dry-run it with
            postil plan before you arm it.
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
