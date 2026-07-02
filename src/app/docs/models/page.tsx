import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Models",
  description:
    "Recommended models for Postil, local inference setup, OpenRouter pricing math, and live model benchmark commands.",
  alternates: { canonical: "/docs/models" },
};

const MODELS = [
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    use: "Default hosted recommendation for balanced code review quality and cost.",
    input: "$0.435",
    output: "$0.870",
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    use: "High-volume teams that want very low inference cost before trying larger models.",
    input: "$0.090",
    output: "$0.180",
  },
  {
    id: "qwen/qwen3.7-plus",
    name: "Qwen3.7 Plus",
    use: "Fast coding reviews with strong price/performance.",
    input: "$0.320",
    output: "$1.280",
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    use: "Code-heavy review sets where long-context reasoning matters more than minimum price.",
    input: "$0.740",
    output: "$3.500",
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM 5.2",
    use: "Long-horizon engineering reviews and larger diffs.",
    input: "$1.400",
    output: "$4.400",
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    use: "Large-context managed inference at a low blended cost.",
    input: "$0.300",
    output: "$1.200",
  },
] as const;

export default function ModelsPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Models</h1>
      <p className="mt-4 text-lg">
        Postil talks to OpenAI-compatible chat completions. Use a managed
        provider such as OpenRouter, bring a direct provider key, or run a local
        endpoint with Ollama, vLLM, SGLang, or LiteLLM.
      </p>

      <h2>Recommended OpenRouter models</h2>
      <p>
        Prices below are dollars per million tokens from the{" "}
        <a href="https://openrouter.ai/api/v1/models" rel="noopener">
          OpenRouter model catalog
        </a>
        . Re-check before committing to a procurement number; the calculator on{" "}
        <Link href="/pricing">pricing</Link> uses the same model ids and default
        token mix.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Use it for</th>
            <th scope="col">Input / 1M</th>
            <th scope="col">Output / 1M</th>
          </tr>
        </thead>
        <tbody>
          {MODELS.map((model) => (
            <tr key={model.id}>
              <td>
                <strong>{model.name}</strong>
                <br />
                <code>{model.id}</code>
              </td>
              <td>{model.use}</td>
              <td>{model.input}</td>
              <td>{model.output}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
        For DeepSeek V4 Pro at the default evidence token mix, that is about
        $0.0009 per review before any managed-inference markup. Larger diffs,
        consensus mode, or multiple model retries increase the number.
      </p>

      <h2>Local models</h2>
      <p>
        Local inference is best for sensitive repositories and for teams that
        already operate GPU capacity. Start with a coder model that can follow
        JSON schema reliably; Postil fails closed when a model cannot produce a
        valid review envelope.
      </p>
      <h3>Ollama</h3>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`ollama pull qwen3-coder:30b
POSTIL_API_BASE=http://localhost:11434/v1 \\
POSTIL_API_KEY=ollama \\
REVIEW_MODEL=qwen3-coder:30b \\
postil doctor`}</code>
      </pre>
      <h3>vLLM or LiteLLM</h3>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`POSTIL_API_BASE=http://localhost:8000/v1
POSTIL_API_KEY=local
REVIEW_MODEL=<served-model-name>
postil review --staged --output-json`}</code>
      </pre>

      <h2>Benchmark your model</h2>
      <p>
        The CLI benchmark harness can score live OpenRouter models against the
        fixture suite. Live mode spends real inference tokens, writes reports
        under <code>postil-cli/bench/.runs</code>, and never prints the API key.
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`cd postil-cli
cargo build --quiet --release
cd bench
POSTIL_API_KEY=... REVIEW_MODEL=deepseek/deepseek-v4-pro AGENT=1 bun run bench:live -- --json
POSTIL_API_KEY=... REVIEW_MODEL=qwen/qwen3.7-plus AGENT=1 bun run bench:live -- --json
POSTIL_API_KEY=... REVIEW_MODEL=moonshotai/kimi-k2.7-code AGENT=1 bun run bench:live -- --json`}</code>
      </pre>
      <p>
        Recommended rollout: run at least DeepSeek V4 Pro, DeepSeek V4 Flash,
        Qwen3.7 Plus, and Kimi K2.7 Code on your own codebase. Promote the
        cheapest model that preserves detection rate and silence on clean PRs.
      </p>
    </div>
  );
}
