import { Code } from "@/components/code";

export const metadata = { title: "Self-hosted" };

export default function SelfHostedDocs() {
  return (
    <article className="container-page py-16 max-w-3xl">
      <h1 className="font-serif text-5xl mb-6">Self-hosted Postil.</h1>
      <p className="text-lg text-[color:var(--color-charcoal-soft)] mb-10 max-w-prose">
        Apache-2.0. Same binary, same envelope, same doctrine as the hosted product.
        GitHub Enterprise Server welcome.
      </p>

      <h2 className="font-serif text-3xl mb-3">docker compose up</h2>
      <Code>{`git clone https://github.com/postil-dev/postil
cd postil
cp .env.example .env  # fill in GITHUB_APP_* and at least one model key
docker compose up -d

# health check
curl http://localhost:3000/api/health`}</Code>

      <p className="text-[color:var(--color-charcoal-soft)] mt-4 mb-10">
        The compose file ships four containers: <code>postgres</code>, <code>web</code>{" "}
        (Next.js), <code>worker</code> (the job runner that spawns{" "}
        <code>postil review</code>), and <code>migrate</code> (one-shot Drizzle
        migration). The CLI is baked into the worker image at a pinned commit, so there
        is no <code>cargo install</code> at runtime.
      </p>

      <h2 className="font-serif text-3xl mb-3">Bring your own model</h2>
      <p className="text-[color:var(--color-charcoal-soft)] mb-3">
        Postil routes through OpenRouter by default. Any model OpenRouter exposes works
        out of the box, including Anthropic, OpenAI, Google, DeepSeek, Moonshot, Qwen,
        and self-hosted Ollama endpoints (via the OpenRouter proxy spec).
      </p>
      <Code>{`# .env
OPENROUTER_API_KEY=sk-or-...
REVIEW_MODEL=anthropic/claude-sonnet-4.6
REVIEW_MODEL_CASCADE=deepseek/deepseek-v4-pro,openai/gpt-5`}</Code>

      <h2 className="font-serif text-3xl mt-10 mb-3">GitHub Enterprise Server</h2>
      <Code>{`# .env
POSTIL_GITHUB_API_URL=https://ghe.your-company.com/api/v3
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY----- ..."`}</Code>

      <h2 className="font-serif text-3xl mt-10 mb-3">Operator endpoints</h2>
      <ul className="space-y-1.5 text-[color:var(--color-charcoal-soft)]">
        <li><code>GET /api/health</code> — liveness probe</li>
        <li><code>GET /api/metrics?days=7</code> — review counts, success rate, stale running, silence rate (bearer <code>METRICS_API_KEY</code>)</li>
        <li><code>POST /api/reviews/watchdog</code> — fail stuck running reviews (bearer)</li>
      </ul>
    </article>
  );
}
