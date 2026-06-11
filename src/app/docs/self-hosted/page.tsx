import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Self-hosted",
  description: "Run the full Postil stack with Docker Compose in under 15 minutes, with OpenRouter, Azure OpenAI, or local Ollama.",
  alternates: { canonical: "/docs/self-hosted" },
};

export default function SelfHostedPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Self-hosted</h1>
      <p className="mt-4 text-lg">
        The same stack we run hosted: Postgres, the web app, and the worker.
        Free forever, no seat limit. Budget under 15 minutes from clone to a
        reviewed test PR.
      </p>

      <h2>Quickstart</h2>
      <pre>
        <code>{`git clone https://github.com/postil-dev/postil
cd postil
cp .env.example .env
# fill in: GitHub App credentials, webhook secret, a sealing key,
#          a session secret, and your LLM key. Each line in
#          .env.example explains its variable.

docker compose up -d
docker compose exec web bun run db:migrate`}</code>
      </pre>
      <p>
        Both web and worker validate their configuration at boot. A missing or
        malformed variable stops the process with the variable name, what it
        is for, and an example value — not a stack trace from the first
        request that happened to need it.
      </p>

      <h2>Pointing it at a model</h2>
      <h3>OpenRouter (default)</h3>
      <pre>
        <code>{`POSTIL_API_BASE=https://openrouter.ai/api/v1
POSTIL_API_KEY=sk-or-v1-...
REVIEW_MODEL=deepseek/deepseek-v4-pro
REVIEW_MODEL_CASCADE=qwen/qwen3-coder`}</code>
      </pre>
      <h3>Azure OpenAI</h3>
      <pre>
        <code>{`POSTIL_API_BASE=https://<resource>.openai.azure.com/openai/v1
POSTIL_API_KEY=<azure-api-key>
REVIEW_MODEL=<deployment-name>`}</code>
      </pre>
      <h3>Ollama (local, no API key)</h3>
      <pre>
        <code>{`POSTIL_API_BASE=http://ollama:11434/v1
POSTIL_API_KEY=ollama        # any non-empty value
REVIEW_MODEL=qwen3-coder:30b`}</code>
      </pre>
      <p>
        Yes, Ollama actually works. The worker talks plain OpenAI-compatible
        chat completions, so anything that serves that API — vLLM, LiteLLM,
        TGI — works the same way.
      </p>

      <h2>postil doctor</h2>
      <p>
        Before opening a test PR, run the doctor inside the worker container.
        It checks the API base is reachable, the key is accepted, and the
        configured model responds:
      </p>
      <pre>
        <code>{`docker compose exec worker postil doctor

  endpoint  http://ollama:11434/v1 ... ok (142ms)
  auth      key accepted ............ ok
  model     qwen3-coder:30b ......... ok (1.2s first token)`}</code>
      </pre>
      <p>
        Every failure mode prints the failing layer and a suggested fix. The
        documented anti-goal: a reviewer that silently falls back to a
        provider you did not configure.
      </p>

      <h2>GitHub App setup</h2>
      <ol>
        <li>
          Create a GitHub App on your org with permissions{" "}
          <code>contents: read</code>, <code>pull_requests: write</code>,{" "}
          <code>checks: write</code>, <code>metadata: read</code>, and the{" "}
          <code>pull_request</code>, <code>installation</code>, and{" "}
          <code>installation_repositories</code> events.
        </li>
        <li>
          Set the webhook URL to{" "}
          <code>https://your-host/api/webhooks/github</code> and generate a
          webhook secret (<code>GITHUB_WEBHOOK_SECRET</code>).
        </li>
        <li>
          Download the App private key and set <code>GITHUB_APP_ID</code> and{" "}
          <code>GITHUB_APP_PRIVATE_KEY</code> (PEM, base64 accepted).
        </li>
        <li>Install the App on a test repository and open a PR.</li>
      </ol>

      <h2>Operations</h2>
      <ul>
        <li>
          <code>/api/health</code> — database ping, suitable for liveness
          probes.
        </li>
        <li>
          <code>/api/metrics</code> — Prometheus text (queue depth, reviews by
          status, silence rate, watchdog kills), bearer-protected by{" "}
          <code>METRICS_TOKEN</code>.
        </li>
        <li>
          The worker's watchdog fails any review running longer than 10
          minutes and completes its check-runs as failed, so a stuck review
          can never hold a PR hostage as eternally in-progress.
        </li>
        <li>
          The CLI binary is baked into the worker image at a pinned commit;
          upgrading the reviewer is an image upgrade, not a runtime download.
        </li>
      </ul>
    </div>
  );
}
