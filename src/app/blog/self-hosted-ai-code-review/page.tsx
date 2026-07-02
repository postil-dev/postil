import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Self-hosted AI code review without the 500-seat enterprise gate",
  description:
    "CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer it at all. Run a full AI code reviewer locally with Ollama in about 15 minutes, free, at any team size.",
  alternates: { canonical: "/blog/self-hosted-ai-code-review" },
  openGraph: {
    type: "article",
    publishedTime: "2026-07-11T00:00:00.000Z",
    title: "Self-hosted AI code review without the 500-seat enterprise gate",
    description:
      "CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer it at all. Run a full AI code reviewer locally with Ollama in about 15 minutes.",
    url: "https://postil.dev/blog/self-hosted-ai-code-review",
    images: ["/opengraph-image"],
  },
};

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline: "Self-hosted AI code review without the 500-seat enterprise gate",
  description:
    "CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer it at all. Run a full AI code reviewer locally with Ollama in about 15 minutes, free, at any team size.",
  url: "https://postil.dev/blog/self-hosted-ai-code-review",
  datePublished: "2026-07-11",
  image: "https://postil.dev/opengraph-image",
  author: {
    "@type": "Organization",
    name: "Postil",
    url: "https://postil.dev",
  },
};

export default function SelfHostedAiCodeReviewArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <p className="eyebrow">Blog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Self-hosted AI code review without the 500-seat enterprise gate
      </h1>
      <p className="mt-4 font-mono text-sm text-charcoal/70">
        July 2026 · Postil team
      </p>

      <div className="prose-postil blog-prose mt-10">
        <p>
          If your code cannot leave the network, the AI code review market has a
          short, frustrating answer for you. Self-hosting exists, but for a
          small or regulated team it is usually either an enterprise sales
          motion with a seat minimum, or one open-source project you assemble
          yourself. The sharpest example is CodeRabbit: its own documentation
          states that{" "}
          <a
            href="https://docs.coderabbit.ai/self-hosted/github"
            rel="noopener"
          >
            &quot;The self-hosted option is only available for CodeRabbit
            Enterprise customers with 500 user seats or more.&quot;
          </a>{" "}
          The gate is a seat count, not a capability. This piece walks through
          who actually lets you self-host and on what terms, and then runs the
          concrete path to a working local review with Postil and Ollama in
          about 15 minutes, at any team size, with no sales call.
        </p>

        <h2>Who actually lets you self-host, and the fine print</h2>
        <p>
          Self-hosting is real in this category, but the terms vary widely. The
          table below is the honest landscape as of June 2026; vendor policies
          change often, so verify before you commit.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Self-host?</th>
              <th scope="col" className="hidden sm:table-cell">
                Terms
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>CodeRabbit</td>
              <td>Yes</td>
              <td className="hidden sm:table-cell">
                Enterprise only, 500+ seats (per its docs)
              </td>
            </tr>
            <tr>
              <td>Greptile</td>
              <td>Yes</td>
              <td className="hidden sm:table-cell">
                Docker/K8s, air-gapped, BYO LLM endpoint, Enterprise tier
              </td>
            </tr>
            <tr>
              <td>Qodo PR-Agent</td>
              <td>Yes</td>
              <td className="hidden sm:table-cell">
                Open source (Apache-2.0), BYO key, Ollama supported
              </td>
            </tr>
            <tr>
              <td>Macroscope</td>
              <td>No</td>
              <td className="hidden sm:table-cell">Hosted only</td>
            </tr>
            <tr>
              <td>GitHub Copilot</td>
              <td>No</td>
              <td className="hidden sm:table-cell">Runs in GitHub&apos;s cloud</td>
            </tr>
            <tr>
              <td>Cursor Bugbot</td>
              <td>No</td>
              <td className="hidden sm:table-cell">
                Connects to self-hosted forges but runs in Cursor&apos;s cloud
              </td>
            </tr>
            <tr>
              <td>Postil</td>
              <td>Yes</td>
              <td className="hidden sm:table-cell">
                Free, no seat limit, BYO key, Ollama supported
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Two patterns stand out. First, where a hosted product offers real
          self-hosting (CodeRabbit, Greptile), it is reserved for the
          enterprise tier, which for a five-person team blocked from sending
          code to an external API is the same as not offering it. Second, the
          tools that abolished seats in favor of usage pricing did so for their
          cloud product; running the model on your own hardware is a different
          axis, and for several of them it simply is not on offer. The Bugbot
          nuance is the one most likely to be mis-stated elsewhere: it can
          review pull requests on a self-hosted forge, but the reviewer itself
          executes in Cursor&apos;s cloud, so your diff still leaves your
          network.
        </p>

        <h2>The real open-source alternative: Qodo PR-Agent</h2>
        <p>
          There is one genuine open-source option for &quot;bring your own key
          plus a local model,&quot; and it deserves credit rather than a
          dismissal. Qodo PR-Agent is{" "}
          <a href="https://github.com/qodo-ai/pr-agent" rel="noopener">
            Apache-2.0 licensed, community-owned, with roughly 11.6k stars
          </a>
          , and it supports multiple models through an OpenAI-compatible /
          LiteLLM layer. Air-gapped setups that put LiteLLM in front of Ollama
          are{" "}
          <a
            href="https://medium.com/@guennounbadr2/air-gapped-paas-ai-pr-reviews-qodo-agent-local-llm-ide-chat-ollama-litellm-99c9279454c2"
            rel="noopener"
          >
            documented by the community
          </a>
          . If you want a self-hosted reviewer and a project to maintain, that
          is a legitimate path.
        </p>
        <p>
          The trade-off is the one any self-assembled stack carries: you own the
          integration. The honest framing is not that PR-Agent is bad; it is
          that &quot;self-host with a local model&quot; means budgeting for the
          glue, the model wiring, and the day a request silently goes to the
          wrong endpoint. That last failure mode is exactly what the rest of
          this article is about avoiding.
        </p>

        <h2>The 15-minute path with Postil and Ollama</h2>
        <p>
          Postil self-hosts the same stack we run hosted: Postgres, the web app,
          and the worker, via Docker Compose. It is free forever with no seat
          limit. The concrete path:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
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
          Two things make the 15-minute budget realistic rather than
          aspirational. First, both the web app and the worker validate their
          configuration at boot: a missing or malformed variable stops the
          process with the variable name, what it is for, and an example value,
          not a stack trace from the first request that happened to need it.
          Second, before you ever open a test PR, <code>postil doctor</code>{" "}
          runs a live probe that proves the whole chain in one shot. Point it at
          Ollama with a one-line block:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`POSTIL_API_BASE=http://ollama:11434/v1
POSTIL_API_KEY=ollama        # any non-empty value
REVIEW_MODEL=qwen3-coder:30b`}</code>
        </pre>
        <p>
          Then run the doctor inside the worker container. The output shape:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`docker compose exec worker postil doctor

  endpoint  http://ollama:11434/v1 ... ok (142ms)
  auth      key accepted ............ ok
  model     qwen3-coder:30b ......... ok (1.2s first token)`}</code>
        </pre>
        <p>
          One caveat carried over from our docs page: those latencies are
          illustrative example values, not a captured benchmark. The checks and
          their pass/fail behavior are real; the millisecond numbers are there
          to show the shape of the output.
        </p>

        <h2>Why &quot;OpenAI-compatible&quot; is the whole trick</h2>
        <p>
          The structural reason there is no seat gate is that there is no hosted
          inference to meter. The Postil worker speaks plain OpenAI-compatible
          chat completions, against{" "}
          <code>POST {"{base}"}/chat/completions</code>. The same binary points
          at Ollama, vLLM, LiteLLM, TGI, Azure OpenAI, or OpenRouter by changing
          one base URL. In self-hosted and BYOK modes there is no proxy in the
          middle and no per-review Postil markup: your inference goes to your
          endpoint at your provider&apos;s rates. Hosted teams can also use managed
          inference, where Postil bills provider cost with a transparent
          pass-through markup.
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`# OpenRouter (default)
POSTIL_API_BASE=https://openrouter.ai/api/v1
POSTIL_API_KEY=sk-or-v1-...

# Azure OpenAI
POSTIL_API_BASE=https://<resource>.openai.azure.com/openai/v1

# Ollama, vLLM, LiteLLM, TGI: same shape, different base URL`}</code>
        </pre>

        <h2>Models worth trying first</h2>
        <p>
          Start with one cheap model and one stronger model, then promote the
          cheapest one that preserves detection rate and silence on clean PRs.
          On OpenRouter today, the practical shortlist is DeepSeek V4 Flash for
          low-cost volume, DeepSeek V4 Pro as the balanced default, Qwen3.7 Plus
          for fast coding reviews, and Kimi K2.7 Code or GLM 5.2 for larger
          engineering diffs. Locally, use the largest coder model your hardware
          can serve reliably and verify it with{" "}
          <code>postil doctor</code> plus the live benchmark harness.
        </p>
        <p>
          The maintained model table and live benchmark commands are in the{" "}
          <a href="/docs/models">models guide</a>.
        </p>

        <h2>The doctor is the differentiator for self-hosters</h2>
        <p>
          The anti-goal is named explicitly in the source: the
          silently-misconfigured self-hosted reviewer, with the wrong
          environment variable, an unreachable endpoint, or a model name typo,
          discovered only when a review silently does nothing. The doctor checks
          each link in the chain and says exactly what to fix, including a live
          one-token completion that proves the base URL, key, and model
          together. The hints are real, in-binary behavior: a 401 or 403 reads
          &quot;key rejected: wrong key for this endpoint?&quot;, a 404 reads
          &quot;wrong apiBase path or unknown model name?&quot;, and a
          connection failure names the Ollama URL to try,{" "}
          <code>http://localhost:11434/v1</code>. For a self-hoster, the gap
          between &quot;it works&quot; and &quot;it silently does nothing&quot;
          is the entire job, and the doctor is built to close it before your
          first PR rather than after a confusing week of quiet output.
        </p>

        <h2>Air-gapped and regulated</h2>
        <p>
          Self-hosted plus Ollama means code never leaves your network. If you
          run in hosted or CLI mode with your own key instead, it goes only to
          the provider you chose, under your own data processing agreement, with
          no Postil-operated hop in between. Either way you control the data
          flow, which is the property procurement actually screens for. The
          forge coverage matters here too, because regulated buyers tend to run
          self-managed Git: GitHub including GitHub Enterprise Server, GitLab
          including self-managed, Bitbucket including Data Center, and Azure
          DevOps including Server, each reached through a base-URL environment
          variable rather than a separate build.
        </p>

        <h2>Operations, briefly</h2>
        <p>
          A few signals that this is operable rather than a toy.{" "}
          <code>/api/health</code> is a cheap web-process liveness check, while{" "}
          <code>/api/health/dependencies</code> checks Postgres readiness.{" "}
          <code>/api/metrics</code> emits Prometheus text, including the silence
          rate and database-up signal, protected by a <code>METRICS_TOKEN</code>{" "}
          bearer. The worker&apos;s watchdog fails any review running longer than 10 minutes
          and completes its check runs as failed, so a stuck review cannot hold
          a PR hostage as eternally in progress. And the CLI binary is baked
          into the worker image at a pinned commit, so upgrading the reviewer is
          an image upgrade, not a runtime download from a network you may have
          deliberately cut off.
        </p>

        <h2>First review now, scale later</h2>
        <p>
          The wedge is simple. Self-hosting in this category is real but mostly
          locked behind an enterprise contract with a seat minimum, or left to a
          DIY open-source project. Postil self-hosts for free, at any team size,
          with bring-your-own-key inference and a doctor that catches the
          misconfiguration that would otherwise make a local reviewer silently
          useless. No claim here that Postil detects more or better than
          CodeRabbit, Greptile, or PR-Agent; there is no comparative data and we
          will not pretend there is. The claim is about availability and the
          deployment model: a full AI code reviewer you can run on your own
          hardware, first review in about 15 minutes, no 500-seat gate, no sales
          call. The detailed how-to lives on the{" "}
          <Link href="/docs/self-hosted">self-hosted docs page</Link>.
        </p>

        <h2>Sources</h2>
        <ul>
          <li>
            <a
              href="https://docs.coderabbit.ai/self-hosted/github"
              rel="noopener"
            >
              CodeRabbit self-hosted docs
            </a>{" "}
            (500-seat Enterprise gate, verbatim; fetched June 13, 2026)
          </li>
          <li>
            <a href="https://github.com/qodo-ai/pr-agent" rel="noopener">
              Qodo PR-Agent (GitHub)
            </a>{" "}
            (Apache-2.0, ~11.6k stars, multi-model; fetched June 13, 2026)
          </li>
          <li>
            <a
              href="https://medium.com/@guennounbadr2/air-gapped-paas-ai-pr-reviews-qodo-agent-local-llm-ide-chat-ollama-litellm-99c9279454c2"
              rel="noopener"
            >
              Community walkthrough: air-gapped PR-Agent with Ollama + LiteLLM
            </a>
          </li>
          <li>
            Postil self-hosting, the doctor, and OpenAI-compatible model
            wiring, grounded in the{" "}
            <Link href="/docs/self-hosted">self-hosted docs</Link> and the
            open-source CLI.
          </li>
        </ul>
      </div>

      <div className="rounded-card shadow-card mt-14 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">Run it on your own hardware.</h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Self-hosted is free, no seat limit, BYO key. First review in about
            15 minutes with Ollama.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
          <Link href="/docs/self-hosted" className="btn-primary text-center">
            Self-hosting guide
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
