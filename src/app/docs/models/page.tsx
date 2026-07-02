import type { Metadata } from "next";
import Link from "next/link";

import { BenchResultsSection } from "@/components/bench-results";
import { ModelCatalog } from "@/components/model-catalog";

export const metadata: Metadata = {
  title: "Models",
  description:
    "Recommended models for Postil, live OpenRouter pricing, capability badges, local inference setup, and measured bench results.",
  alternates: { canonical: "/docs/models" },
};

export default function ModelsPage() {
  return (
    <div>
      <div className="prose-postil">
        <h1 className="serif-display text-4xl text-charcoal">Models</h1>
        <p className="mt-4 text-lg">
          Postil talks to OpenAI-compatible chat completions. Use a managed
          provider such as OpenRouter, bring a direct provider key, or run a
          local endpoint with Ollama, vLLM, SGLang, or LiteLLM.
        </p>
        <p>
          Every model does the same job: read a diff, decide what is worth
          flagging. The difference is capability and price, not use case — so
          the table below leads with facts (context, vision, weights,
          parameter class) instead of per-model recommendations.
        </p>
      </div>

      <div className="mt-8 max-w-4xl">
        <h2 className="serif-display text-2xl text-charcoal">
          Model catalog
        </h2>
        <p className="prose-postil mt-2">
          Prices are fetched live from the{" "}
          <a href="https://openrouter.ai/models" rel="noopener" className="text-rust underline">
            OpenRouter catalog
          </a>
          , never committed as static numbers. <code>default</code> marks
          the models Postil recommends out of the box; the rest are a
          curated set spanning cost and locally-runnable open-weights
          options. Re-check before committing to a procurement number; the
          calculator on <Link href="/pricing" className="text-rust underline">pricing</Link>{" "}
          uses the same model ids.
        </p>
        <div className="mt-4">
          <ModelCatalog />
        </div>
      </div>

      <div className="prose-postil mt-14">
        <h2>Cost per review</h2>
        <p>
          The evidence fixtures on this site average 978 prompt tokens and 544
          completion tokens. The formula is straightforward:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`review_cost =
  prompt_tokens * input_price_per_token +
  completion_tokens * output_price_per_token`}</code>
        </pre>
        <p>
          Multiply against the live price in the table above for a rough
          per-review number before any managed-inference markup. Larger
          diffs, consensus mode, or multiple model retries increase it.
        </p>
      </div>

      <div className="prose-postil mt-10">
        <h2>Local models</h2>
        <p>
          Local inference is best for sensitive repositories and for teams
          that already operate GPU capacity. The catalog above marks
          open-weights models under 40B parameters as{" "}
          <code>locally runnable</code> — start there. Postil fails closed
          when a model cannot produce a valid review envelope, so pick a
          coder-tuned model that follows JSON schema reliably.
        </p>
        <h3>Ollama</h3>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`ollama pull qwen3:32b
POSTIL_API_BASE=http://localhost:11434/v1 \\
POSTIL_API_KEY=ollama \\
REVIEW_MODEL=qwen3:32b \\
postil doctor`}</code>
        </pre>
        <h3>vLLM or LiteLLM</h3>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`POSTIL_API_BASE=http://localhost:8000/v1
POSTIL_API_KEY=local
REVIEW_MODEL=<served-model-name>
postil review --staged --output-json`}</code>
        </pre>
      </div>

      <div className="mt-14">
        <h2 className="serif-display text-2xl text-charcoal">
          Measured on our bench
        </h2>
        <p className="prose-postil mt-2">
          Method: seeded-defect fixtures run through a mock forge against the
          real model, scored against ground truth. Mean cost per review is
          the headline column — it reflects actual reviews produced, ahead of
          catalog list price.
        </p>
        <p className="prose-postil mt-2">
          Read detection rate as a floor, not a ranking: the current fixture
          set seeds clear, unambiguous defects, and capable models saturate
          it. It tells you a model handles the review pipeline and obvious
          bugs at the stated cost — a harder, non-public fixture set for
          separating frontier models is planned and its results will be
          published the same way.
        </p>
        <div className="mt-4">
          <BenchResultsSection />
        </div>
      </div>

      <div className="prose-postil mt-14">
        <h2>Run the bench yourself</h2>
        <p>
          The CLI benchmark harness can score live OpenRouter models against
          the fixture suite. Live mode spends real inference tokens, writes
          reports under <code>postil-cli/bench/.runs</code>, and never
          prints the API key.
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`cd postil-cli
cargo build --quiet --release
cd bench
POSTIL_API_KEY=... REVIEW_MODEL=deepseek/deepseek-v4-pro AGENT=1 bun run bench:live -- --json
POSTIL_API_KEY=... REVIEW_MODEL=moonshotai/kimi-k2.6 AGENT=1 bun run bench:live -- --json
POSTIL_API_KEY=... REVIEW_MODEL=qwen/qwen3-32b AGENT=1 bun run bench:live -- --json`}</code>
        </pre>
        <p>
          Promote the cheapest model that preserves detection rate and
          silence on clean PRs for your own codebase — the numbers above are
          a starting point, not a substitute for running it on your diffs.
        </p>
      </div>
    </div>
  );
}
