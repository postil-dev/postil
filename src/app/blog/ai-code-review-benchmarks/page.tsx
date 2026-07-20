import Link from "next/link";

import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("ai-code-review-benchmarks");
export const metadata = blogPostMetadata(post);
const articleJsonLd = blogPostJsonLd(post);

export default function BenchmarkAuthorArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <BlogArticleHeader post={post} />

      <div className="prose-postil blog-prose mt-10">
        <p>
          All four vendors surveyed here that publish an AI code review
          benchmark (Greptile, Qodo, Augment, and Macroscope) win their own
          benchmark. Each chart puts the publisher&apos;s logo on top. That is
          the predictable result of a design choice: when you build the test,
          pick the metric, and assemble the dataset, you influence the answer
          before anyone runs anything. This piece walks through the public
          evidence for that claim and gives you a five-point test for any
          benchmark in your tabs, including ours.
        </p>

        <h2>Exhibit A: the same dataset, two scores</h2>
        <p>
          The single most legible proof that the number travels with the scorer
          rather than the tool is Greptile&apos;s benchmark. Greptile reports an{" "}
          <a href="https://www.greptile.com/benchmarks" rel="noopener">
            82% overall bug-catch rate
          </a>{" "}
          on its own evaluation, built from 50 real bug-fix PRs (10 per repo
          across five repos), with the bugs reconstructed by reverting the fixes
          onto clean forks, conducted in July 2025. Then a competitor, Augment,
          re-ran the same five repositories. As{" "}
          <a
            href="https://deepsource.com/blog/ai-code-review-benchmarks"
            rel="noopener"
          >
            DeepSource documented
          </a>
          , Greptile scored 45% in that run, not 82%. Same repos, same tool,
          roughly half the score, the only thing that changed was who held the
          stopwatch. Across the four benchmark publishers surveyed here, the
          publisher ranks itself first.
        </p>

        <h2>Why catch rate alone is a rigged frame</h2>
        <p>
          The deeper problem is what the headline metric leaves out. Greptile&apos;s
          methodology, stated on its own benchmark page, scores only whether the
          original bug was detected. Verbatim:{" "}
          <a href="https://www.greptile.com/benchmarks" rel="noopener">
            &quot;false positives, style suggestions, and unrelated comments did
            not affect the catch rate.&quot;
          </a>{" "}
          Read that again with a buyer&apos;s hat on. A tool that comments on
          everything cannot lose a recall-only benchmark, because the noise it
          generates is invisible to the score. But noise is the actual pain.
          Teams turn off AI reviewers because of false positives, not because of
          missed bugs, and a benchmark that refuses to count false positives is
          blind by construction to the failure mode that matters most. Catch
          rate without precision is half a measurement presented as a whole one.
        </p>

        <h2>The vendor-benchmark zoo</h2>
        <p>
          Once you know to look for it, the pattern repeats across the category.
          None of these are dishonest in the legal sense. They are reasonable
          marketing artifacts. The problem is reading them as science.
        </p>
        <div className="not-prose my-8 overflow-hidden rounded-card border border-charcoal/10">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-charcoal/[0.03] text-left">
                <th className="px-4 py-3 font-semibold">Vendor benchmark</th>
                <th className="px-4 py-3 font-semibold">Headline result</th>
                <th className="hidden px-4 py-3 font-semibold sm:table-cell">
                  Dataset
                </th>
                <th className="px-4 py-3 font-semibold">Who wins</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal/10">
              <tr>
                <td className="px-4 py-3 align-top">
                  <a href="https://www.greptile.com/benchmarks" rel="noopener">
                    Greptile
                  </a>
                </td>
                <td className="px-4 py-3 align-top">
                  82% catch rate, false positives unscored
                </td>
                <td className="hidden px-4 py-3 align-top sm:table-cell">
                  50 reverted bug-fix PRs, 5 repos
                </td>
                <td className="px-4 py-3 align-top">Greptile</td>
              </tr>
              <tr>
                <td className="px-4 py-3 align-top">
                  <a
                    href="https://www.qodo.ai/blog/how-we-built-a-real-world-benchmark-for-ai-code-review/"
                    rel="noopener"
                  >
                    Qodo
                  </a>
                </td>
                <td className="px-4 py-3 align-top">
                  F1 60.1%, &quot;best overall&quot;
                </td>
                <td className="hidden px-4 py-3 align-top sm:table-cell">
                  100 PRs, 580 LLM-injected bugs
                </td>
                <td className="px-4 py-3 align-top">Qodo</td>
              </tr>
              <tr>
                <td className="px-4 py-3 align-top">
                  <a
                    href="https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results"
                    rel="noopener"
                  >
                    Augment
                  </a>
                </td>
                <td className="px-4 py-3 align-top">F1 59%, ranked first</td>
                <td className="hidden px-4 py-3 align-top sm:table-cell">
                  50 PRs, &quot;corrected&quot; Greptile set
                </td>
                <td className="px-4 py-3 align-top">Augment</td>
              </tr>
              <tr>
                <td className="px-4 py-3 align-top">Macroscope</td>
                <td className="px-4 py-3 align-top">
                  Self-published precision claim
                </td>
                <td className="hidden px-4 py-3 align-top sm:table-cell">
                  Own bug set
                </td>
                <td className="px-4 py-3 align-top">Macroscope</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Qodo&apos;s benchmark used 100 PRs with 580 issues injected by an LLM,
          and Qodo reports an{" "}
          <a
            href="https://www.qodo.ai/blog/how-we-built-a-real-world-benchmark-for-ai-code-review/"
            rel="noopener"
          >
            F1 of 60.1% and ranks itself first
          </a>
          . Augment&apos;s benchmark ran 50 PRs across five large open-source
          repos, described as an expanded and corrected version of Greptile&apos;s
          golden set, and{" "}
          <a
            href="https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results"
            rel="noopener"
          >
            Augment reports the highest F1 at 59% and ranks itself first
          </a>
          . Macroscope self-publishes a precision claim on its own bug set as
          well. The directional reading of these is fine. Each tells you the
          vendor cares about a metric and tuned for it. The leaderboard reading
          is what fails, because there is no neutral referee and no shared
          ground truth across any two of these tests.
        </p>

        <h2>What independent data shows: near-zero agreement</h2>
        <p>
          The most useful counterweight is the one study that ran multiple tools
          in parallel without a horse in the race for any single product&apos;s
          number. A practitioner{" "}
          <a
            href="https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f"
            rel="noopener"
          >
            ran four reviewers (CodeRabbit, Sentry Seer, Greptile, Cursor
            Bugbot) in parallel for 3.5 weeks
          </a>{" "}
          across 146 merged PRs, producing 679 findings across 446 review
          events. The result: 93.4% of flagged locations were caught by exactly
          one tool, and zero locations were flagged by all four. Volume varied
          enormously, with CodeRabbit emitting 281 findings and Greptile 120 at
          near-zero false positives across its verdicts. The author discloses up
          front that they work at Sentry, which makes Seer one of the four, and
          says so plainly, which is exactly the honesty this whole piece is
          arguing for.
        </p>
        <p>
          Sit with the 93.4% number. If these tools were measuring the same
          underlying thing, the way two thermometers measure the same
          temperature, they would overlap heavily. They almost never do. A
          leaderboard implies an agreed-upon ground truth, a fixed set of bugs
          that exist independently of the tool looking for them. The parallel
          run says that ground truth does not exist in practice. These products
          are emitting opinions about diffs, and how loud each one is is a
          product decision, not a fact about the code.
        </p>

        <h2>The academic counter-model: score the silence</h2>
        <p>
          Academia built the test the vendor benchmarks omit.{" "}
          <a href="https://arxiv.org/abs/2509.01494" rel="noopener">
            SWR-Bench
          </a>{" "}
          is 1,000 manually verified PRs, deliberately split 500 change-PRs and
          500 clean-PRs. The clean half is the point. Any comment a tool
          generates on a clean PR counts, by definition, as a false positive.
          Evaluation is LLM-based with roughly 90% agreement with human raters.
          That structure means a tool cannot win by commenting on everything,
          because half the test rewards saying nothing, and the headline finding
          is that current AI code review systems substantially underperform on
          this balanced framing. A benchmark with no clean PRs in it literally
          cannot punish a tool for noise. SWR-Bench can, which is why it lands
          differently from anything a vendor publishes.
        </p>

        <h2>What an honest evaluation looks like</h2>
        <p>
          Strip the marketing away and an evaluation worth trusting has to clear
          five bars. Use this as a checklist against any vendor&apos;s
          &quot;benchmark,&quot; including the one in the tab next to this.
        </p>
        <ul>
          <li>
            <strong>Clean PRs are in the set, and they are scored.</strong> If
            the test only contains PRs with planted bugs, silence is never the
            correct answer and noise is never penalized.
          </li>
          <li>
            <strong>False positives are counted, not discarded.</strong> A
            recall-only score rewards the chattiest tool. Precision has to be in
            the chart, not a footnote.
          </li>
          <li>
            <strong>
              A precision or silence metric is reported next to recall.
            </strong>{" "}
            One number without the other is half a measurement.
          </li>
          <li>
            <strong>Enough artifacts are published for a fair re-run.</strong>{" "}
            The Greptile 82%-to-45% gap only became visible because someone could
            re-run the dataset. Irreproducible scores are assertions, and
            private datasets should be treated as internal evidence rather than
            public leaderboards.
          </li>
          <li>
            <strong>The author is not the only vendor in the chart.</strong> If
            the publisher is also the winner, treat the result as directional
            marketing until a third party reproduces it.
          </li>
        </ul>

        <h2>Where Postil stands</h2>
        <p>
          We are not exempt from this critique, so we are specific about what we
          do and do not claim. Postil publishes methodology, not a leaderboard.
          The <Link href="/evidence">evidence page</Link> links real GitHub
          check-runs so each published catch can be inspected at its source. We
          report no Postil score against a competitor. The product doctrine is
          narrower: silence is a feature, findings without a citation are
          discarded, and the system fails closed rather than guessing loudly.
        </p>
        <p>
          We have not run a peer benchmark or put a rival tool on our fixtures.
          A chart authored by Postil with the Postil logo above competitors would
          have the same conflict described throughout this article. Apply the
          same five-point checklist to our published evidence.
        </p>

        <h2>Run the test yourself</h2>
        <p>
          The next time you hit a &quot;we benchmarked the category and won&quot;
          page, do not argue with the number. Apply the checklist. Are there
          clean PRs in the set? Are false positives counted? Is precision next to
          recall? Are enough artifacts public for a fair re-run, or is the
          dataset private? Is the author the only vendor in the chart? The
          answers expose what each score measures and omits more clearly than
          the leaderboard does. Point the same five questions at Postil&apos;s
          published evidence.
        </p>

        <h2>Sources</h2>
        <ul>
          <li>
            <a href="https://www.greptile.com/benchmarks" rel="noopener">
              Greptile benchmark
            </a>{" "}
            (82% catch rate, false positives explicitly unscored; 50 reverted
            bug-fix PRs)
          </li>
          <li>
            <a
              href="https://deepsource.com/blog/ai-code-review-benchmarks"
              rel="noopener"
            >
              DeepSource benchmark survey
            </a>{" "}
            (Greptile 82% vs 45% on Augment&apos;s re-run)
          </li>
          <li>
            <a
              href="https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results"
              rel="noopener"
            >
              Augment: we benchmarked 7 AI code review tools
            </a>{" "}
            (F1 59%, Augment ranks first)
          </li>
          <li>
            <a
              href="https://www.qodo.ai/blog/how-we-built-a-real-world-benchmark-for-ai-code-review/"
              rel="noopener"
            >
              Qodo: how we built a real-world benchmark
            </a>{" "}
            (F1 60.1%, Qodo ranks first; 580 LLM-injected bugs)
          </li>
          <li>
            <a
              href="https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f"
              rel="noopener"
            >
              Independent 4-tool parallel study, 146 PRs, 679 findings
            </a>{" "}
            (93.4% caught by exactly one tool, zero by all four; author at
            Sentry, COI disclosed)
          </li>
          <li>
            <a href="https://arxiv.org/abs/2509.01494" rel="noopener">
              SWR-Bench (arXiv)
            </a>{" "}
            (1,000 PRs, 500 clean / 500 change, false positives scored by
            definition)
          </li>
        </ul>
      </div>

      <div className="rounded-card shadow-card mt-14 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">
            Methodology, not a leaderboard.
          </h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            See Postil&apos;s real catches on public pull requests, with the
            exact check-run behind every one.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
          <Link href="/evidence" className="btn-primary text-center">
            See it run
          </Link>
          <Link
            href="/docs/envelope"
            className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-center text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
          >
            Read the envelope spec
          </Link>
        </div>
      </div>
    </div>
  );
}
