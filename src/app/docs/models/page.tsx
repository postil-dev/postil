import type { Metadata } from "next";

import { BenchResultsSection } from "@/components/bench-results";
import { ModelCatalog } from "@/components/model-catalog";

export const metadata: Metadata = {
  title: "Models",
  description:
    "Recommended models for Postil, public OpenRouter price snapshots, capability badges, local inference setup, and measured bench results.",
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
          flagging. The difference is capability and price, not use case, so
          the table below leads with facts (context, vision, weights,
          parameter class) instead of per-model recommendations.
        </p>
      </div>

      <div className="mt-8 max-w-4xl">
        <h2 className="serif-display text-2xl text-charcoal">
          Model catalog
        </h2>
        <p className="prose-postil mt-2">
          This table uses committed public price snapshots from the{" "}
          <a href="https://openrouter.ai/models" rel="noopener noreferrer" className="text-rust underline">
            OpenRouter catalog
          </a>
          . <code>default</code> marks the models Postil recommends out of the
          box; the rest are a curated set spanning cost and locally-runnable
          open-weights options. Re-check live provider pricing before
          committing to a procurement number.
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
          Multiply against the snapshot price in the table above for a rough
          per-review number. Larger diffs, consensus mode, or multiple model
          retries increase it.
        </p>
      </div>

      <div className="prose-postil mt-10">
        <h2>Local models</h2>
        <p>
          Local inference is best for sensitive repositories and for teams
          that already operate GPU capacity. The catalog above marks
          open-weights models under 40B parameters as{" "}
          <code>locally runnable</code>. Start there. Postil fails closed
          when a model cannot produce a valid review envelope, so pick a
          coder-tuned model that follows JSON schema reliably.
        </p>
        <h3>Ollama</h3>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`ollama pull qwen3:32b
POSTIL_API_BASE=http://localhost:11434/v1 \\
MODEL_API_KEY=ollama \\
POSTIL_API_KEY=ollama \\
REVIEW_MODEL=qwen3:32b \\
postil doctor`}</code>
        </pre>
        <h3>vLLM or LiteLLM</h3>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`export POSTIL_API_BASE=http://localhost:8000/v1
export MODEL_API_KEY=local
export POSTIL_API_KEY="$MODEL_API_KEY"
export REVIEW_MODEL=served-model-name
postil review --staged --output-json`}</code>
        </pre>
      </div>

      <div className="mt-14">
        <h2 className="serif-display text-2xl text-charcoal">
          Measured on our bench
        </h2>
        <p className="prose-postil mt-2">
          Method: seeded-defect fixtures run through a mock forge against the
          real model, scored against ground truth. Mean cost per review is the
          headline column; total cost shows aggregate spend for the checked-in
          run.
        </p>
        <p className="prose-postil mt-2">
          Read detection rate as a floor, not a ranking: the checked-in live
          report below uses 40 fixtures, with 33 seeded defects and 7 clean
          PRs where the correct review is silence. These fixtures seed clear,
          unambiguous defects, and capable models can saturate them. They show
          that a model handles the review pipeline and obvious bugs at the
          stated cost.
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
          <code>{`cd postil-cli/bench
export MODEL_API_KEY=...
export POSTIL_API_KEY="$MODEL_API_KEY"
export POSTIL_BENCH_MODELS=deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash,moonshotai/kimi-k2.6
bun run bench:live-models -- --json-out .runs/live-models.json`}</code>
        </pre>
        <p>
          Promote the cheapest model that preserves detection rate and
          silence on clean PRs for your own codebase. The numbers above are
          a starting point, not a substitute for running it on your diffs.
        </p>
      </div>
    </div>
  );
}
