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
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`git clone https://github.com/postil-dev/postil
cd postil
cp .env.example .env
# Fill in the required values before the first up. Each line in
# .env.example explains its variable. See "Required configuration"
# below for the full list and how to generate each one.

docker compose up -d
docker compose exec web bun run db:migrate`}</code>
      </pre>
      <p>
        The compose file pins the reviewer CLI to a released version
        (<code>POSTIL_CLI_REV</code>, default a current tag) and fetches it
        during the image build, so a clean clone builds without extra steps.
        Set <code>POSTIL_CLI_REV</code> to a different tag or a 40-character
        commit to change the reviewer version, or drop a prebuilt binary at{" "}
        <code>vendor/postil</code> to skip the fetch.
      </p>
      <p>
        Both web and worker validate their configuration at boot. A missing or
        malformed variable stops the process with the variable name, what it
        is for, and an example value — not a stack trace from the first
        request that happened to need it.
      </p>

      <h2>Required configuration</h2>
      <p>
        Compose injects <code>DATABASE_URL</code> for both services. Everything
        else comes from your <code>.env</code>. The web process refuses to boot
        without all of its required variables, and so does the worker.
      </p>
      <h3>Web</h3>
      <ul>
        <li>
          <code>POSTIL_SESSION_SECRET</code>: signs session cookies.{" "}
          <code>openssl rand -hex 32</code>.
        </li>
        <li>
          <code>GITHUB_WEBHOOK_SECRET</code>: verifies webhook signatures;
          must match the secret on the GitHub App.{" "}
          <code>openssl rand -hex 32</code>.
        </li>
        <li>
          <code>GITHUB_OAUTH_CLIENT_ID</code> and{" "}
          <code>GITHUB_OAUTH_CLIENT_SECRET</code>: dashboard sign-in. These
          come from a GitHub OAuth App, which is separate from the GitHub App
          (see below). The web container exits at boot if either is empty.
        </li>
        <li>
          <code>POSTIL_SEALING_KEY</code>: AES-256-GCM key sealing org BYO API
          keys at rest; required for both web and worker.{" "}
          <code>openssl rand -hex 32</code>.
        </li>
      </ul>
      <h3>Worker</h3>
      <ul>
        <li>
          <code>GITHUB_APP_ID</code>: numeric id from the GitHub App settings
          page.
        </li>
        <li>
          <code>GITHUB_APP_PRIVATE_KEY</code>: the App private key; raw PEM or
          base64-encoded PEM.
        </li>
        <li>
          <code>POSTIL_SEALING_KEY</code>: same key as web.
        </li>
        <li>
          The LLM variables below are optional for boot but needed for reviews
          to run.
        </li>
      </ul>

      <h2>Pointing it at a model</h2>
      <p>
        These are worker variables. <code>POSTIL_API_KEY</code> falls back to{" "}
        <code>OPENROUTER_API_KEY</code> if it is unset.{" "}
        <code>REVIEW_MODEL_CASCADE</code> is an optional comma-separated list of
        fallback models tried in order on provider errors.
      </p>
      <h3>OpenRouter (default)</h3>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`POSTIL_API_BASE=https://openrouter.ai/api/v1
POSTIL_API_KEY=sk-or-v1-...
REVIEW_MODEL=deepseek/deepseek-v4-pro
REVIEW_MODEL_CASCADE=qwen/qwen3-coder`}</code>
      </pre>
      <h3>Azure OpenAI</h3>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`POSTIL_API_BASE=https://<resource>.openai.azure.com/openai/v1
POSTIL_API_KEY=<azure-api-key>
REVIEW_MODEL=<deployment-name>`}</code>
      </pre>
      <h3>Ollama (local, no API key)</h3>
      <p>
        Ollama is not part of the default stack; you run it yourself. The
        compose file ships an optional <code>ollama</code> service behind a
        profile;
        bring it up and pull a model before the first review:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen3-coder:30b`}</code>
      </pre>
      <p>Then point the worker at it on the compose network:</p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`POSTIL_API_BASE=http://ollama:11434/v1
POSTIL_API_KEY=ollama        # any non-empty value
REVIEW_MODEL=qwen3-coder:30b`}</code>
      </pre>
      <p>
        If you already run Ollama on the host instead, drop the profile and use{" "}
        <code>POSTIL_API_BASE=http://host.docker.internal:11434/v1</code>{" "}
        (add <code>extra_hosts: [&quot;host.docker.internal:host-gateway&quot;]</code>{" "}
        to the <code>worker</code> service on Linux).
      </p>
      <p>
        The worker talks plain OpenAI-compatible chat completions, so anything
        that serves that API (vLLM, LiteLLM, TGI) works the same way.
      </p>

      <h2>postil doctor</h2>
      <p>
        Before opening a test PR, run the doctor inside the worker container.
        It resolves the config, checks the git work tree, the API key, a live
        probe of the model endpoint, and any forge tokens. Inside the worker it
        reads <code>REVIEW_MODEL</code>, <code>POSTIL_API_BASE</code>, and{" "}
        <code>POSTIL_API_KEY</code> from the container env, so set those in{" "}
        <code>.env</code> before running it:
      </p>
      {/* Illustrative demo output: the five checks, their order, and the
          [ok  ]/[FAIL] format match the CLI (src/doctor.rs print_report); the
          detail strings are example values from a reachable Ollama run. */}
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`docker compose exec worker postil doctor

[ok  ] config           loaded from defaults (model: qwen3-coder:30b, gate failOn: error, minConfidence: 0.6)
[FAIL] git              not a git repository (local modes --staged/--base need one)
[ok  ] api key          POSTIL_API_KEY or OPENROUTER_API_KEY is set (value not shown)
[ok  ] model endpoint   http://ollama:11434/v1 answered for model qwen3-coder:30b
[ok  ] forge tokens     GITHUB_TOKEN unset, GITLAB_TOKEN unset (only needed for remote review)

postil doctor: ready.`}</code>
      </pre>
      <p>
        The <code>git</code> check reports FAIL inside the worker container
        because <code>/app</code> is not a work tree; that is expected and does
        not block PR reviews, which run against a fetched diff. The line that
        matters for setup is <code>model endpoint</code>: it must say your base
        answered for your model. Every failure prints the failing layer and a
        suggested fix. The documented anti-goal: a reviewer that silently falls
        back to a provider you did not configure.
      </p>

      <h2>GitHub setup</h2>
      <p>
        Self-hosting needs two distinct GitHub registrations: a GitHub App
        (delivers webhooks and mints installation tokens for reviews) and a
        GitHub OAuth App (dashboard sign-in). The web container will not boot
        without the OAuth credentials.
      </p>
      <h3>GitHub App</h3>
      <ol>
        <li>
          Create a GitHub App on your org with permissions{" "}
          <code>contents: read</code>, <code>pull_requests: write</code>,{" "}
          <code>checks: write</code>, <code>metadata: read</code>, and the{" "}
          <code>pull_request</code>, <code>installation</code>, and{" "}
          <code>installation_repositories</code> events. For the interactive{" "}
          <code>@postil</code> bot, also add <code>issues: write</code>,{" "}
          <code>issue_comment</code>, and pull request review comment events.
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
      <h3>GitHub OAuth App</h3>
      <ol>
        <li>
          Create a GitHub OAuth App (Settings → Developer settings → OAuth
          Apps), separate from the GitHub App above.
        </li>
        <li>
          Set the Authorization callback URL to{" "}
          <code>https://your-host/api/auth/callback</code>.
        </li>
        <li>
          Set <code>GITHUB_OAUTH_CLIENT_ID</code> and{" "}
          <code>GITHUB_OAUTH_CLIENT_SECRET</code> from the OAuth App page.
        </li>
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
