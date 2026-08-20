import Link from "next/link";

import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import {
  DETECTION_BAND_POINTS,
  MODELS_IN_DETECTION_BAND,
  SCORED_MODELS,
} from "@/components/bench-table";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("the-least-useful-number");
export const metadata = blogPostMetadata(post);
const articleJsonLd = blogPostJsonLd(post);

export default function LeastUsefulNumberArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <BlogArticleHeader post={post} />

      <div className="prose-postil blog-prose mt-10">
        <p>
          We publish a table of model benchmark results. It was measured
          against a fixture set that no longer exists, on a build seven minor
          versions old, and it flattered every small model on it. So we re-ran
          everything: {SCORED_MODELS.length} models, one corpus, one binary,
          one afternoon. The results changed which model we run, and they
          changed what we think the table is for.
        </p>

        <h2>Detection rate barely separates anything</h2>
        <p>
          The column everyone leads with is how many seeded defects a model
          finds. We ran two models four times each to see how stable it is.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Four runs</th>
              <th scope="col">Spread</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>z-ai/glm-5.2</code></td>
              <td>94.7, 89.5, 87.7, 89.5</td>
              <td>7.0 points</td>
            </tr>
            <tr>
              <td><code>moonshotai/kimi-k2.7-code</code></td>
              <td>94.7, 89.5, 98.2, 94.7</td>
              <td>8.7 points</td>
            </tr>
          </tbody>
        </table>
        <p>
          One unchanged model, one unchanged fixture set, nine points of
          movement. On our full table, {MODELS_IN_DETECTION_BAND} of{" "}
          {SCORED_MODELS.length} models sit within {DETECTION_BAND_POINTS}{" "}
          points of the best one. The headline metric cannot tell most of them
          apart, and any single-run comparison between two of them is measuring
          the weather.
        </p>
        <p>
          This is not a claim that detection does not matter. It is a claim
          about resolution: if your instrument moves nine points on its own,
          you cannot report a three-point difference as a result. We had been
          doing exactly that, including in our release gate, which blocked five
          of seven releases by comparing one run against a baseline recorded
          from a single lucky run at the top of the same distribution.
        </p>

        <h2>Silence separates them cleanly</h2>
        <p>
          Two columns were steady across repeats: how often a model stays quiet
          on a clean pull request, and how often the merge gate blocks exactly
          when it should. Those are also the two that decide whether anyone
          keeps the tool switched on.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Detected</th>
              <th scope="col">Silent on 13 clean PRs</th>
              <th scope="col">False findings</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>mistralai/mistral-small-3.2-24b</code></td>
              <td>91.2%</td>
              <td>6</td>
              <td>7</td>
            </tr>
            <tr>
              <td><code>google/gemma-3-27b-it</code></td>
              <td>87.7%</td>
              <td>4</td>
              <td>8</td>
            </tr>
            <tr>
              <td><code>qwen/qwen3-32b</code></td>
              <td>86.0%</td>
              <td>8</td>
              <td>12</td>
            </tr>
            <tr>
              <td><code>openai/gpt-5.6-luna</code></td>
              <td>96.5%</td>
              <td>13</td>
              <td>0</td>
            </tr>
          </tbody>
        </table>
        <p>
          Those first three are within five points of each other on detection
          and nowhere near each other in practice. Gemma 3 interrupts nine of
          thirteen clean pull requests. Our own published table had it at 97%
          with one false positive, because the old corpus had fewer adversarial
          clean cases. Mistral Small was published at 100% detection and zero
          false positives; on the current fixtures it raises seven false
          findings and stays quiet on six of thirteen clean diffs.
        </p>
        <p>
          We had been recommending both. That is the cost of leaving a
          benchmark table up after the thing it measured has changed
          underneath, and it is why every figure on the new page carries the
          digest of the corpus it was scored against.
        </p>

        <h2>A version number is not an upgrade</h2>
        <p>
          The day before we ran this, the vendor of the model we were using
          released its successor. Same family, same context window, same price.
          It failed to produce valid structured output on eighteen of seventy
          cases, emitted twice the reasoning tokens, and cost three times as
          much. Upgrading on the version number alone, which is the obvious
          move, would have been a straight downgrade with a bill attached.
        </p>

        <h2>Cost is a reasoning budget, not a price</h2>
        <p>
          The cheapest model per token in our sweep charges $0.08 per million
          input tokens. It emitted 582,000 completion tokens to finish the
          fixture set and took 87 seconds at the ninety-fifth percentile. The
          model that won the sweep emitted 31,500 completion tokens, finished
          in 21 seconds, and cost less in total despite a higher per-token
          price.
        </p>
        <p>
          Per-token pricing tells you almost nothing about what a review costs.
          How much a model thinks before answering tells you nearly everything,
          and it is not on any pricing page. You have to run it.
        </p>

        <h2>We were measuring a route we cannot use</h2>
        <p>
          The worst mistake of the exercise was ours, and we made it three
          times. Our screening harness lets the router pick any endpoint.
          Hosted reviews cannot: they require a zero-retention endpoint, pin
          one upstream provider, and cap the price. Every number above was
          measured without those constraints, and we kept reading them as
          though they described what customers would get.
        </p>
        <p>
          Re-running the two finalists under the real contract settled it. One
          was unaffected. The other, which we had been about to select on the
          strength of a rock-steady 18-second tail latency, went to 58 seconds
          once pinned to a zero-retention provider: the endpoint the router had
          been quietly choosing for it was one we are not allowed to use.
        </p>
        <p>
          If you run a benchmark to pick a model for a constrained deployment,
          constrain the benchmark the same way. Otherwise you are measuring a
          product you cannot ship.
        </p>

        <h2>What we changed</h2>
        <p>
          We moved off the model we were running. The replacement was one we
          had already rejected: in July, a preflight guard refused it because
          projected qualification spend exceeded its cap, so it made zero
          calls. The price has since fallen fivefold. The rejection was filed
          in the same shape as a quality failure, so nobody revisited it. A
          rejection on cost is perishable evidence and ours was not marked as
          such.
        </p>
        <p>
          We also re-recorded our release baseline from the median of four runs
          rather than a single run, which is what stops the gate failing by
          construction on a metric that moves nine points on its own.
        </p>

        <h2>Read it yourself</h2>
        <p>
          Every model we scored is on the{" "}
          <Link href="/bench" className="text-rust underline">
            model bench page
          </Link>
          , including the ones that did badly and the one that could not be
          reached at all, with the raw report and the command to reproduce it.
          These are our fixtures and we build the product they score, so apply
          our own{" "}
          <Link href="/blog/ai-code-review-benchmarks" className="text-rust underline">
            five-point test for benchmarks
          </Link>{" "}
          to them. The reproduction command is the part that matters.
        </p>
      </div>
    </div>
  );
}
