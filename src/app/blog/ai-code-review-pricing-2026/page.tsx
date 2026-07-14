import type { Metadata } from "next";
import Link from "next/link";

import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
} from "@/lib/pricing-policy";

const TEAM_SIZE = 20;
const HOSTED_TEAM_MONTHLY_USD = TEAM_SIZE * HOSTED_ACTIVE_AUTHOR_MONTHLY_USD;
const BYOK_TEAM_MONTHLY_USD = TEAM_SIZE * BYOK_ACTIVE_AUTHOR_MONTHLY_USD;

export const metadata: Metadata = {
  title: "AI code review pricing in 2026: what a 20-developer team actually pays",
  description:
    "Four AI code review vendors changed pricing models in roughly ninety days. We run the same 20-developer team through CodeRabbit, Qodo, Greptile, Macroscope, Copilot, Bugbot, and Postil, with every assumption stated and every price sourced.",
  alternates: { canonical: "/blog/ai-code-review-pricing-2026" },
  openGraph: {
    type: "article",
    publishedTime: "2026-07-08T00:00:00.000Z",
    title:
      "AI code review pricing in 2026: what a 20-developer team actually pays",
    description:
      "The same 20-developer team priced through seven AI code review tools, with every assumption stated and every price sourced.",
    url: "https://postil.dev/blog/ai-code-review-pricing-2026",
    images: ["/opengraph-image"],
  },
};

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline:
    "AI code review pricing in 2026: what a 20-developer team actually pays",
  description:
    "The same 20-developer team priced through seven AI code review tools, with every assumption stated and every price sourced.",
  url: "https://postil.dev/blog/ai-code-review-pricing-2026",
  datePublished: "2026-07-08",
  image: "https://postil.dev/opengraph-image",
  author: {
    "@type": "Organization",
    name: "Postil",
    url: "https://postil.dev",
  },
};

export default function PricingArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <p className="eyebrow">Blog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        AI code review pricing in 2026: what a 20-developer team actually pays
      </h1>
      <p className="mt-4 font-mono text-sm text-charcoal/70">
        July 2026 · Postil team
      </p>

      <div className="prose-postil blog-prose mt-10">
        <p>
          Between March and June 2026, four major AI code review vendors
          changed how they charge. Greptile added a per-review overage,
          Macroscope abandoned seats for per-kilobyte metering, Cursor Bugbot
          abandoned seats for per-run billing, and GitHub Copilot moved to
          consumption-based AI Credits. Most pricing comparisons on the
          internet predate at least one of those changes. This article prices
          one concrete team, 20 developers with a stated PR volume, through
          every major tool, with the arithmetic shown and every number traced
          to a vendor page or announcement. Qodo pricing uses the public
          credit-pack prices; the other listed prices use public vendor
          sources.
        </p>
        <p>
          Disclosure first: we build Postil, one of the seven tools below. This
          piece makes no claim about which tool reviews code better; review
          quality is a separate question we have written about elsewhere and
          cannot settle here. This is pricing arithmetic only, and the Postil
          row is held to the same standard as everyone else&apos;s: list
          prices, stated assumptions, sources. Where a vendor&apos;s pricing
          cannot be computed from public information, we say so instead of
          guessing.
        </p>

        <h2>What changed, and when</h2>
        <p>
          The 2026 story is a category-wide flight from flat seats toward
          metered billing, compressed into about ninety days:
        </p>
        <ul>
          <li>
            <strong>Greptile (March 2026).</strong> Moved to{" "}
            <a href="https://www.greptile.com/pricing" rel="noopener">
              $30 per seat per month with 50 reviews included, then $1 per
              review
            </a>
            . The change drew an{" "}
            <a
              href="https://news.ycombinator.com/item?id=47966075"
              rel="noopener"
            >
              HN backlash
            </a>{" "}
            and a dedicated protest site (published April 30, 2026) that{" "}
            <a href="https://greptile-fail.vercel.app/" rel="noopener">
              claims a single seat can reach roughly $339 per month
            </a>{" "}
            at agent-driven PR volume and alleges there are no spend caps.
            Those are a critic&apos;s figures, not Greptile&apos;s, but the
            mechanism they describe is real: every review past 50 per seat
            bills a dollar.
          </li>
          <li>
            <strong>Macroscope (March 27, 2026).</strong> Replaced its
            $30-per-developer seat plan (5-seat minimum at its September 2025
            launch) with{" "}
            <a href="https://docs.macroscope.com/pricing" rel="noopener">
              usage pricing: $0.05 per KB of diff with a 10 KB minimum
            </a>
            . Macroscope says most reviews are under the minimum and cost
            $0.50, with a 30 KB medium feature costing $1.50. Spend caps are
            available. Two pricing models in six months is worth noting when
            you forecast next year&apos;s bill.
          </li>
          <li>
            <strong>Cursor Bugbot (announced May 11, 2026).</strong> Dropped
            its $40 per seat plan for{" "}
            <a
              href="https://cursor.com/blog/may-2026-bugbot-changes"
              rel="noopener"
            >
              usage billing at roughly $1.00 to $1.50 per review run
            </a>
            , effective at renewals after June 8. There is{" "}
            <a
              href="https://forum.cursor.com/t/rate-card-for-bugbot-usage-based-pricing-and-effort-settings-not-visible/160347"
              rel="noopener"
            >
              no published rate card
            </a>
            , and forum users argue the model{" "}
            <a
              href="https://forum.cursor.com/t/the-new-usage-based-bugbot-pricing-punishes-iterative-workflows-and-power-users/161134"
              rel="noopener"
            >
              punishes iterative workflows
            </a>
            , since every push to an open PR can bill another run.
          </li>
          <li>
            <strong>GitHub Copilot (June 1, 2026).</strong> Moved to{" "}
            <a
              href="https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/"
              rel="noopener"
            >
              consumption-based &quot;AI Credits&quot;
            </a>
            , and code review now also{" "}
            <a
              href="https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/"
              rel="noopener"
            >
              consumes GitHub Actions minutes
            </a>{" "}
            (announced April 27, 2026). One user&apos;s report:{" "}
            <a
              href="https://www.reddit.com/r/GithubCopilot/comments/1tvjhm1/i_wholeheartedly_recommend_to_everyone_to_turn/"
              rel="noopener"
            >
              &quot;Mine just burned through 100% of Included credits plus
              extra 1.92 USD… it was just 1 regular automatic PR code
              review.&quot;
            </a>
          </li>
          <li>
            <strong>Qodo.</strong> Pro Team pricing is now credit-pack based:{" "}
            <a href="https://www.qodo.ai/pricing/" rel="noopener">
              $0.012 per credit, a $30 starting point, and self-serve designed
              for up to 30 users
            </a>
            .
          </li>
          <li>
            <strong>CodeRabbit.</strong> Still seat-based:{" "}
            <a href="https://www.coderabbit.ai/pricing" rel="noopener">
              Pro at $24 per user per month annual
            </a>
            , with the cheaper Lite tier removed and a $48 Pro Plus tier added
            in spring 2026. Users on r/coderabbit have{" "}
            <a
              href="https://www.reddit.com/r/coderabbit/comments/1tyt2qj/coderabbit_pro_price_changed_from_21_to_30/"
              rel="noopener"
            >
              reported price increases appearing without announcement
            </a>
            . Note also the per-tier hourly review rate limits (5 reviews per
            developer per hour on Pro, 10 on Pro Plus).
          </li>
        </ul>

        <h2>The worked example: one team, stated assumptions</h2>
        <p>
          Vendor pricing pages quote a unit price; your bill is unit price
          times volume. So the assumptions matter more than the rate card, and
          we state ours explicitly:
        </p>
        <ul>
          <li>
            <strong>20 developers</strong>, all of whom open PRs (so all of
            them need seats on seat-based plans).
          </li>
          <li>
            <strong>8 merged PRs per developer per month</strong>, or 160 PRs
            per month for the team. A moderate pace; agent-assisted teams often
            run far higher.
          </li>
          <li>
            <strong>2.5 review runs per PR on average</strong>: the initial
            review plus re-reviews after follow-up pushes. That gives 400
            review runs per month, or 20 per developer. This is the number
            usage-billed tools meter.
          </li>
          <li>
            <strong>Annual billing</strong> wherever a discount exists.
          </li>
        </ul>
        <p>
          We also show a second scenario where it changes the ranking: an
          agent-heavy team shipping 30 PRs per developer per month with 3 runs
          per PR (90 runs per developer, 1,800 runs per month). That volume is
          exactly what the 2026 pricing changes were designed to monetize.
        </p>

        <h2>Tool by tool</h2>

        <h3>CodeRabbit: $480/month</h3>
        <p>
          20 seats × $24 (Pro, annual) = <strong>$480 per month</strong>,
          regardless of PR volume. The $48 Pro Plus tier, required for custom
          pre-merge checks, doubles that to $960. The flat seat price is the
          most predictable bill among the incumbents; the things to check are
          the hourly review rate limits and the reported unannounced price
          changes linked above. Source:{" "}
          <a href="https://www.coderabbit.ai/pricing" rel="noopener">
            coderabbit.ai/pricing
          </a>
        </p>

        <h3>Qodo: credit-pack billing</h3>
        <p>
          Qodo Pro Team starts at <strong>$30 per month</strong> with pooled
          credits at $0.012 per credit. The pricing page frames Pro Team as
          self-serve for up to 30 users, while the usage docs describe shared
          workspace credits and overage caps. Because review consumption
          depends on credit-pack choice and usage, the table treats Qodo as a
          starting floor rather than a 20-seat total. Sources:{" "}
          <a href="https://www.qodo.ai/pricing/" rel="noopener">
            qodo.ai/pricing
          </a>{" "}
          and{" "}
          <a href="https://docs.qodo.ai/pricing-and-usage" rel="noopener">
            docs.qodo.ai/pricing-and-usage
          </a>
        </p>

        <h3>Greptile: $600/month, until volume moves</h3>
        <p>
          20 seats × $30 = $600, with 50 reviews per seat included (1,000 for
          the team). At our base volume of 400 runs per month the team stays
          inside the pool: <strong>$600 per month</strong>. The overage is the
          story. In the agent-heavy scenario, each developer&apos;s 90 runs
          exceed the included 50 by 40, billing $40 per developer on top of
          the seat: 20 × ($30 + $40) = <strong>$1,400 per month</strong>, and
          the bill keeps scaling linearly with every additional review run.
          Source:{" "}
          <a href="https://www.greptile.com/pricing" rel="noopener">
            greptile.com/pricing
          </a>
        </p>

        <h3>Macroscope: roughly $80 to $240/month</h3>
        <p>
          No seats at all. Using Macroscope&apos;s own examples of $0.50 for
          most under-minimum reviews and $1.50 for a 30 KB medium feature, 160
          PRs cost <strong>roughly $80 to $240 per month</strong>. At this volume it
          is the cheapest paid option in the table, and spend caps bound the
          downside. In the agent-heavy scenario (600 PRs), the same range
          gives roughly $300 to $900. The caveats: actual cost depends on your
          diff sizes, not PR counts ($0.05 per KB, 10 KB minimum), it is
          GitHub Cloud only, and the pricing model has changed twice in six
          months. Source:{" "}
          <a href="https://docs.macroscope.com/pricing" rel="noopener">
            docs.macroscope.com/pricing
          </a>
        </p>

        <h3>Copilot code review: $380/month plus an amount we cannot compute</h3>
        <p>
          Code review requires a paid Copilot plan: 20 × $19 (Business) ={" "}
          <strong>$380 per month</strong> as the floor. On top of that, since
          June 1, 2026, each review consumes AI Credits and the agentic run
          consumes GitHub Actions minutes. We are not publishing a worked
          total because GitHub has not published a stable credits-per-review
          figure we can verify, and user reports of credit consumption{" "}
          <a
            href="https://www.reddit.com/r/GithubCopilot/comments/1tvjhm1/i_wholeheartedly_recommend_to_everyone_to_turn/"
            rel="noopener"
          >
            vary widely
          </a>
          . That non-answer is itself the finding: a team cannot compute its
          Copilot code review bill from list prices in advance. Sources:{" "}
          <a
            href="https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/"
            rel="noopener"
          >
            GitHub&apos;s AI Credits announcement
          </a>{" "}
          and the{" "}
          <a
            href="https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/"
            rel="noopener"
          >
            Actions-minutes changelog
          </a>{" "}
          (April 27, 2026).
        </p>

        <h3>Cursor Bugbot: roughly $400 to $600/month</h3>
        <p>
          400 review runs at Cursor&apos;s stated average of $1.00 to $1.50
          per run is <strong>roughly $400 to $600 per month</strong>, drawn
          from plan-included usage and then on-demand spend. In the agent-heavy
          scenario (1,800 runs), the same arithmetic gives roughly $1,800 to
          $2,700. Both figures carry an asterisk: there is no published rate
          card, so the per-run cost is Cursor&apos;s described average, not a
          price you can hold them to. Per-run billing also means the
          review-fix-push loop itself is metered. Sources:{" "}
          <a
            href="https://cursor.com/blog/may-2026-bugbot-changes"
            rel="noopener"
          >
            Cursor&apos;s May 2026 announcement
          </a>{" "}
          and{" "}
          <a href="https://cursor.com/docs/bugbot" rel="noopener">
            cursor.com/docs/bugbot
          </a>
        </p>

        <h3>Postil: active-author pricing</h3>
        <p>
          Our row assumes all {TEAM_SIZE} developers open a private-repository
          PR that Postil reviews. Hosted is {TEAM_SIZE} active authors × $
          {HOSTED_ACTIVE_AUTHOR_MONTHLY_USD} ={" "}
          <strong>${HOSTED_TEAM_MONTHLY_USD} per month</strong>. BYOK is{" "}
          {TEAM_SIZE} × ${BYOK_ACTIVE_AUTHOR_MONTHLY_USD} ={" "}
          <strong>${BYOK_TEAM_MONTHLY_USD} per month</strong>, with provider
          usage billed directly. Hosted public-repository reviews are free.
          Source: <Link href="/pricing">postil.dev/pricing</Link>.
        </p>

        <h2>The comparison table</h2>
        <p>
          Base scenario: 20 developers, 160 PRs and 400 review runs per month,
          annual billing. Prices use vendor list pages and linked
          announcements. This category re-prices often, so verify before
          buying.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col" className="hidden sm:table-cell">
                Pricing model
              </th>
              <th scope="col">20-dev monthly (base scenario)</th>
              <th scope="col">Bill grows with</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>CodeRabbit Pro</td>
              <td className="hidden sm:table-cell">Per seat</td>
              <td>$480 ($960 on Pro Plus)</td>
              <td>Seats only</td>
            </tr>
            <tr>
              <td>Qodo Pro Team</td>
              <td className="hidden sm:table-cell">Credit packs</td>
              <td>From $30/mo credit pack</td>
              <td>Credits, enterprise above 30 users</td>
            </tr>
            <tr>
              <td>Greptile</td>
              <td className="hidden sm:table-cell">Per seat + per review</td>
              <td>$600 ($1,400 agent-heavy)</td>
              <td>Review runs past 50/seat</td>
            </tr>
            <tr>
              <td>Macroscope</td>
              <td className="hidden sm:table-cell">Per KB of diff</td>
              <td>~$80–$240 (~$300–$900 agent-heavy)</td>
              <td>Diff volume</td>
            </tr>
            <tr>
              <td>Copilot code review</td>
              <td className="hidden sm:table-cell">Plan + usage</td>
              <td>$380 + credits (not computable)</td>
              <td>AI Credits, Actions minutes</td>
            </tr>
            <tr>
              <td>Cursor Bugbot</td>
              <td className="hidden sm:table-cell">Per run</td>
              <td>~$400–$600 (~$1,800–$2,700 agent-heavy)</td>
              <td>Review runs, incl. re-reviews</td>
            </tr>
            <tr>
              <td>Postil</td>
              <td className="hidden sm:table-cell">Active private-PR author</td>
              <td>
                ${HOSTED_TEAM_MONTHLY_USD} Hosted / ${BYOK_TEAM_MONTHLY_USD} BYOK
              </td>
              <td>Review volume is not a Postil billing unit</td>
            </tr>
          </tbody>
        </table>
        <p>
          Two readings of the same table. If your volume is low and steady,
          usage pricing is genuinely cheap: Macroscope at $80 to $240
          undercuts every seat plan here. If your volume is high or growing,
          the metered rows are the ones that tripled between the two
          scenarios while the seat rows did not move.
        </p>

        <h2>When usage-based pricing actually wins</h2>
        <p>
          It would be convenient for us to declare flat pricing always better.
          It is not, and the honest version of the argument has three parts.
        </p>
        <p>
          Usage billing wins when volume is low, spiky, or unevenly
          distributed. A 20-person org where six people open PRs in a given
          month wastes fourteen seats on any per-seat plan. A consultancy
          between projects pays Macroscope almost nothing in a quiet month and
          would pay CodeRabbit the full $480. Metered pricing is also the only
          model that does not punish you for the developer who opens two PRs a
          quarter. If that describes your team, the per-KB and per-run rows
          above are rational choices, especially where spend caps exist.
        </p>
        <p>
          Usage billing loses when the unit being metered is one your own
          tooling multiplies. The 2026 complaint threads are not about unit
          prices; they are about discovering that agents, stacked PRs, and
          iterative push-review-fix loops multiply the metered unit faster
          than anyone budgeted. That is the Greptile overage story, the Bugbot{" "}
          <a
            href="https://forum.cursor.com/t/the-new-usage-based-bugbot-pricing-punishes-iterative-workflows-and-power-users/161134"
            rel="noopener"
          >
            iterative-workflow complaint
          </a>
          , and the Copilot credit-burn reports, all within one quarter. The
          deeper problem is the incentive: once a review vendor bills per
          review, it profits from every re-review its own comments provoke.
        </p>
        <p>
          The third part is predictability as a property of its own. A bill
          you can forecast within a few percent is worth something even when
          a metered bill might be lower, because budget surprises have
          organizational costs that unit prices do not capture. Our own
          position follows from that: Postil charges $
          {HOSTED_ACTIVE_AUTHOR_MONTHLY_USD} per active private-PR author for
          Hosted, or ${BYOK_ACTIVE_AUTHOR_MONTHLY_USD} per active author for
          BYOK. When you choose BYOK, provider usage stays in your account and
          Postil adds no per-review fee. That property comes from the pricing
          structure itself, and you can check it on{" "}
          <Link href="/pricing">our pricing page</Link>.
        </p>
        <p>
          Whichever model you pick, do the arithmetic above with your own
          numbers before you sign: your PR count, your runs per PR, your
          seat count. Every vendor page in the sources below quotes a unit
          price. None of them quotes your bill.
        </p>

        <h2>Sources</h2>
        <ul>
          <li>
            Vendor pricing pages:{" "}
            <a href="https://www.coderabbit.ai/pricing" rel="noopener">
              coderabbit.ai/pricing
            </a>
            ,{" "}
            <a href="https://www.qodo.ai/pricing/" rel="noopener">
              qodo.ai/pricing
            </a>
            ,{" "}
            <a href="https://docs.qodo.ai/pricing-and-usage" rel="noopener">
              docs.qodo.ai/pricing-and-usage
            </a>
            ,{" "}
            <a href="https://www.greptile.com/pricing" rel="noopener">
              greptile.com/pricing
            </a>
            ,{" "}
            <a href="https://docs.macroscope.com/pricing" rel="noopener">
              docs.macroscope.com/pricing
            </a>
            ,{" "}
            <a href="https://cursor.com/docs/bugbot" rel="noopener">
              cursor.com/docs/bugbot
            </a>
          </li>
          <li>
            Pricing-change announcements:{" "}
            <a
              href="https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/"
              rel="noopener"
            >
              GitHub Copilot AI Credits (June 1, 2026)
            </a>
            ,{" "}
            <a
              href="https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/"
              rel="noopener"
            >
              Copilot review consuming Actions minutes (April 27, 2026)
            </a>
            ,{" "}
            <a
              href="https://cursor.com/blog/may-2026-bugbot-changes"
              rel="noopener"
            >
              Cursor Bugbot usage billing (May 11, 2026)
            </a>
          </li>
          <li>
            Community reaction:{" "}
            <a href="https://greptile-fail.vercel.app/" rel="noopener">
              Greptile pricing protest site (April 30, 2026)
            </a>
            ,{" "}
            <a
              href="https://news.ycombinator.com/item?id=47966075"
              rel="noopener"
            >
              HN thread on Greptile pricing
            </a>
            ,{" "}
            <a
              href="https://forum.cursor.com/t/the-new-usage-based-bugbot-pricing-punishes-iterative-workflows-and-power-users/161134"
              rel="noopener"
            >
              Cursor forum on per-run billing
            </a>
            ,{" "}
            <a
              href="https://forum.cursor.com/t/rate-card-for-bugbot-usage-based-pricing-and-effort-settings-not-visible/160347"
              rel="noopener"
            >
              Cursor forum on the missing rate card
            </a>
            ,{" "}
            <a
              href="https://www.reddit.com/r/GithubCopilot/comments/1tvjhm1/i_wholeheartedly_recommend_to_everyone_to_turn/"
              rel="noopener"
            >
              r/GithubCopilot credit-burn report
            </a>
            ,{" "}
            <a
              href="https://www.reddit.com/r/coderabbit/comments/1tyt2qj/coderabbit_pro_price_changed_from_21_to_30/"
              rel="noopener"
            >
              r/coderabbit on unannounced price changes
            </a>
          </li>
        </ul>
      </div>

      <div className="rounded-card shadow-card mt-14 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">
            Run the math on your own numbers.
          </h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Postil prices private plans by active author, not by review or
            repository.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
          <Link href="/pricing" className="btn-primary text-center">
            See pricing
          </Link>
          <Link
            href="/install"
            className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-center text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
          >
            Install the CLI
          </Link>
        </div>
      </div>
    </div>
  );
}
