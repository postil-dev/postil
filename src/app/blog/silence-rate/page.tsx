import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "The silence rate: the AI code review metric nobody publishes",
  description:
    "Developers stop reading AI reviewers above roughly 30% false positives. The metric that predicts it is the one no vendor benchmark reports: how often the tool correctly says nothing.",
  alternates: { canonical: "/blog/silence-rate" },
  openGraph: {
    type: "article",
    publishedTime: "2026-06-13T00:00:00.000Z",
    title: "The silence rate: the AI code review metric nobody publishes",
    description:
      "Developers stop reading AI reviewers above roughly 30% false positives. The metric that predicts it: how often the tool correctly says nothing.",
    url: "https://postil.dev/blog/silence-rate",
    images: ["/opengraph-image"],
  },
};

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline: "The silence rate: the AI code review metric nobody publishes",
  description:
    "Developers stop reading AI reviewers above roughly 30% false positives. The metric that predicts it is the one no vendor benchmark reports: how often the tool correctly says nothing.",
  url: "https://postil.dev/blog/silence-rate",
  datePublished: "2026-06-13",
  image: "https://postil.dev/opengraph-image",
  author: {
    "@type": "Organization",
    name: "Postil",
    url: "https://postil.dev",
  },
};

export default function SilenceRateArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <p className="eyebrow">Blog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        The silence rate: the AI code review metric nobody publishes
      </h1>
      <p className="mt-4 font-mono text-sm text-charcoal/60">
        June 2026 · Postil team
      </p>

      <div className="prose-postil blog-prose mt-10">
        <p>
          Ask any team that has turned off an AI code reviewer why they did it
          and you will hear the same word: noise. Not &quot;it missed
          bugs.&quot; Noise. The tool commented too much, was wrong too often,
          and the team stopped reading it, which means it also stopped reading
          the correct findings. This piece is about the number that predicts
          that outcome, why no vendor reports it, and why we decided to make it
          the first thing on Postil&apos;s dashboard.
        </p>

        <h2>The 30% threshold</h2>
        <p>
          AI reviewers can generate 200 to 400 comments per week on an active
          repository, with 70 to 90% of them ignored, according to{" "}
          <a
            href="https://www.codeant.ai/blogs/prevent-ai-code-review-overload"
            rel="noopener"
          >
            one analysis of review overload
          </a>
          . The same analysis describes a behavioral cliff: above roughly 30%
          false positives, developers triage every comment with suspicion;
          above 50%, they dismiss by default. The failure is not that the tool
          wastes time on bad findings. It is that bad findings destroy the
          credibility of good ones. Once a team learns the reviewer is usually
          wrong, the real bug it flags on Friday gets the same dismissive
          glance as the forty nitpicks before it.
        </p>
        <p>
          The practitioner record is blunt. &quot;Too much noise to PRs, and
          only a very small percentage of comments are actually useful&quot; (
          <a href="https://news.ycombinator.com/item?id=42451968" rel="noopener">
            HN, Dec 2024
          </a>
          ). &quot;I am no longer spending my time solving engineering
          challenges; I am perfecting code to pass an AI screen… It&apos;s
          theater&quot; (
          <a
            href="https://www.reddit.com/r/webdev/comments/1skfg0k/has_anyone_else_found_copilot_review_to_be_kind/"
            rel="noopener"
          >
            r/webdev, 2026
          </a>
          ). A founder evaluating the category found two leading tools{" "}
          <a
            href="https://www.reddit.com/r/ycombinator/comments/1nl0too/coderabbit_raises_60m_valued_at_550m_thoughts/"
            rel="noopener"
          >
            &quot;at best added noise to PRs, at worst flagged false
            positives&quot;
          </a>
          . Even a Cursor employee, in a thread about their own Bugbot,{" "}
          <a
            href="https://www.reddit.com/r/cursor/comments/1qm2sz0/has_anyone_here_been_using_bugbot/"
            rel="noopener"
          >
            conceded
          </a>
          : &quot;You can always ask an LLM for a review but you should expect
          a lot of false positives, noisy comments, and inconsistent
          results.&quot;
        </p>

        <h2>Even the good reviews measure a third wasted</h2>
        <p>
          The best public data point comes from a review that liked the
          product. The Lychee open-source project{" "}
          <a href="https://lycheeorg.dev/2025-09-13-code-rabbit/" rel="noopener">
            audited CodeRabbit across 28 PRs and 290 findings
          </a>{" "}
          and recommended it. The same audit classified 21% of findings as
          nitpicks, 15% as useless, and 13% as based on wrong assumptions.
          Roughly a third of the output of a well-regarded tool, measured by a
          sympathetic reviewer, was waste. That is what &quot;good&quot;
          currently looks like in this category, and it sits right at the
          threshold where developers start tuning out.
        </p>

        <h2>Why vendors will not publish it</h2>
        <p>
          The incentive problem is structural, and practitioners have named
          it: vendors are rewarded for{" "}
          <a href="https://news.ycombinator.com/item?id=46766961" rel="noopener">
            &quot;more feedback (not higher quality)&quot;
          </a>
          , because a reviewer that stays quiet looks broken to the buyer who
          just installed it. Every comment is visible evidence the product is
          working. Silence, even correct silence, generates a &quot;is this
          thing on?&quot; support ticket. So defaults trend chatty, and the
          metric that would expose the cost of that choice goes unreported.
        </p>
        <p>
          You can see the omission clearly in the benchmarks.{" "}
          <a
            href="https://deepsource.com/blog/ai-code-review-benchmarks"
            rel="noopener"
          >
            DeepSource documented
          </a>{" "}
          that every vendor benchmark in the category ranks its own product
          first, including that{" "}
          <a
            href="https://deepsource.com/blog/ai-code-review-benchmarks"
            rel="noopener"
          >
            when Augment re-ran Greptile&apos;s evaluation on the same dataset,
            Greptile scored 45% against its self-reported 82%
          </a>
          . Greptile&apos;s benchmark{" "}
          <a href="https://www.greptile.com/benchmarks" rel="noopener">
            explicitly does not score false positives
          </a>
          . Qodo&apos;s benchmark drew the obvious HN response:{" "}
          <a href="https://news.ycombinator.com/item?id=46891860" rel="noopener">
            &quot;Company creates a benchmark. Same company is best in that
            benchmark. Story as old as time.&quot;
          </a>{" "}
          Catch-rate theater is easy; precision accounting is not.
        </p>
        <p>
          The independent evidence is thinner but more interesting. A
          practitioner{" "}
          <a
            href="https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f"
            rel="noopener"
          >
            ran four reviewers in parallel for 3.5 weeks
          </a>{" "}
          across 146 PRs and 679 findings (author works at Sentry, conflict
          disclosed) and found that 93.4% of flagged locations were caught by
          exactly one tool. Four products looking at the same diffs almost
          never agreed on what mattered. If these tools were measuring
          something objective, they would overlap. They are not; they are
          emitting opinions, and volume is a choice each vendor makes.
        </p>
        <p>
          Academia noticed the gap too.{" "}
          <a href="https://arxiv.org/abs/2509.01494" rel="noopener">
            SWR-Bench
          </a>{" "}
          built a 1,000-PR evaluation where half the PRs are intentionally
          clean, specifically so that saying nothing is a scored answer, and
          found current systems substantially underperform. That design choice
          is the whole point: a benchmark that contains no clean PRs cannot
          punish a tool for commenting on everything.
        </p>

        <h2>Defining the silence rate</h2>
        <p>
          The silence rate is the share of reviewed PRs where the tool posted
          zero findings. On its own it is trivially gameable (a tool that
          never speaks scores 100%), which is why it only means something
          paired with its complement: of the findings the tool did ship, how
          many were acted on rather than dismissed? A reviewer with a high
          silence rate and a high act-on rate is doing the job senior engineers
          do: most PRs are fine, say so by saying nothing, and when you do
          speak, be right. The only public number close to this from a major
          vendor is GitHub&apos;s, mentioned in passing in a{" "}
          <a
            href="https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/"
            rel="noopener"
          >
            blog post
          </a>
          : Copilot code review stays silent on roughly 29% of reviews. It is
          a real disclosure and GitHub deserves credit for it, but it is a
          one-off marketing statistic, not a number you can check on your own
          repositories this month.
        </p>

        <h2>Why Postil reports it first</h2>
        <p>
          Postil&apos;s dashboard leads with the silence rate: the share of
          your PRs where it said nothing, alongside the confidence distribution
          of every finding it did ship. Not because silence is a virtue in
          itself, but because publishing the number changes our incentives. A
          vendor that reports its silence rate cannot quietly inflate comment
          volume to look busy; drift toward noise shows up in a chart before
          your engineers feel it in their notifications. It is the same logic
          as a chef sitting in their own dining room.
        </p>
        <p>
          What we are not claiming: that Postil&apos;s silence rate beats any
          competitor&apos;s. No peer has run our benchmark and we have not
          published comparative numbers, so there is nothing honest to claim
          yet. The claim is narrower and checkable: the metric exists, it is
          on the dashboard from day one, and you can watch it on your own
          traffic. You can <Link href="/evidence">see it run</Link> on three
          real diffs, including one where it correctly stays silent.
        </p>

        <h2>What to ask any vendor (including us)</h2>
        <ul>
          <li>
            What share of PRs does your tool stay silent on, and where do I see
            that number for my repos, continuously?
          </li>
          <li>
            What share of shipped findings get dismissed or ignored, and is
            that on the dashboard too?
          </li>
          <li>
            Does your benchmark include clean PRs where the correct answer is
            silence? If not, what stops the tool from commenting on everything?
          </li>
          <li>
            Can I run advisory-only for two weeks and see these numbers before
            anything becomes a required check?
          </li>
        </ul>
        <p>
          That last one matters most. The adoption pattern recommended in{" "}
          <a href="https://techsy.io/en/blog/ai-code-review-guide" rel="noopener">
            third-party integration guides
          </a>{" "}
          is to run any AI reviewer advisory for a couple of weeks and promote
          it to a required check only if the dismissal rate stays under
          roughly 30%. If a vendor cannot show you the numbers
          that decision needs, that is itself the answer.
        </p>

        <h2>Sources</h2>
        <ul>
          <li>
            <a
              href="https://www.codeant.ai/blogs/prevent-ai-code-review-overload"
              rel="noopener"
            >
              CodeAnt: preventing AI code review overload
            </a>{" "}
            (comment volume, 30%/50% thresholds)
          </li>
          <li>
            <a
              href="https://lycheeorg.dev/2025-09-13-code-rabbit/"
              rel="noopener"
            >
              Lychee: 28-PR CodeRabbit audit (Sep 2025)
            </a>
          </li>
          <li>
            <a
              href="https://deepsource.com/blog/ai-code-review-benchmarks"
              rel="noopener"
            >
              DeepSource: AI code review benchmark critique (Feb 2026)
            </a>
          </li>
          <li>
            <a
              href="https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f"
              rel="noopener"
            >
              Independent 4-tool parallel study, 146 PRs (May 2026)
            </a>
          </li>
          <li>
            <a href="https://arxiv.org/abs/2509.01494" rel="noopener">
              SWR-Bench (arXiv)
            </a>
          </li>
          <li>
            <a
              href="https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/"
              rel="noopener"
            >
              GitHub: 60 million Copilot code reviews
            </a>
          </li>
          <li>
            Practitioner threads:{" "}
            <a
              href="https://news.ycombinator.com/item?id=42451968"
              rel="noopener"
            >
              HN (Dec 2024)
            </a>
            ,{" "}
            <a
              href="https://news.ycombinator.com/item?id=46766961"
              rel="noopener"
            >
              HN (Jan 2026)
            </a>
            ,{" "}
            <a
              href="https://news.ycombinator.com/item?id=46891860"
              rel="noopener"
            >
              HN on the Qodo benchmark
            </a>
            ,{" "}
            <a
              href="https://www.reddit.com/r/webdev/comments/1skfg0k/has_anyone_else_found_copilot_review_to_be_kind/"
              rel="noopener"
            >
              r/webdev
            </a>
            ,{" "}
            <a
              href="https://www.reddit.com/r/ycombinator/comments/1nl0too/coderabbit_raises_60m_valued_at_550m_thoughts/"
              rel="noopener"
            >
              r/ycombinator
            </a>
            ,{" "}
            <a
              href="https://www.reddit.com/r/cursor/comments/1qm2sz0/has_anyone_here_been_using_bugbot/"
              rel="noopener"
            >
              r/cursor
            </a>
          </li>
        </ul>
      </div>

      <div className="rounded-card shadow-card mt-14 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">Watch the number yourself.</h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Run Postil advisory on your next PRs. The silence rate is the
            first thing on the dashboard.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
          <Link href="/install" className="btn-primary text-center">
            Install the CLI
          </Link>
          <Link
            href="/evidence"
            className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-center text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
          >
            See it run
          </Link>
        </div>
      </div>
    </div>
  );
}
