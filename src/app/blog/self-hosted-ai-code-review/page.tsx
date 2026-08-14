import Link from "next/link";

import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { doctorTranscript } from "@/data/transcripts";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("self-hosted-ai-code-review");
export const metadata = blogPostMetadata(post);
const articleJsonLd = blogPostJsonLd(post);

export default function SelfHostedAiCodeReviewArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <BlogArticleHeader post={post} />

      <div className="prose-postil blog-prose mt-10">
        <p>
          If your code cannot leave the network, the AI code review market has a
          short, frustrating answer for you. Self-hosting exists, but for a
          small or regulated team it is usually either an enterprise sales
          motion with a seat minimum, or one open-source project you assemble
          yourself. The sharpest example is CodeRabbit: its public AWS
          Marketplace listing describes self-hosted delivery with list pricing
          for 500 users, and its usage instructions set a 500-user minimum for
          developer seats.{" "}
          <a
            href="https://aws.amazon.com/marketplace/pp/prodview-wkkkre4fgelwq"
            rel="noopener"
          >
            The AWS Marketplace listing sets the self-hosted minimum at 500
            seats.
          </a>{" "}
          This piece walks through who actually lets you self-host and on what
          terms, then follows Postil&apos;s scripted path from clone to a local
          review with Ollama, at any team size, with no sales call.
        </p>

        <h2>Who actually lets you self-host, and the fine print</h2>
        <p>
          Self-hosting is real in this category, but the terms vary widely. The
          table below is the honest landscape; vendor policies change often,
          so verify before you commit.
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
                Enterprise self-hosted listing, 500-user minimum
              </td>
            </tr>
            <tr>
              <td>Greptile</td>
              <td>Yes</td>
              <td className="hidden sm:table-cell">
                Docker/K8s, air-gapped, BYOK LLM endpoint, Enterprise tier
              </td>
            </tr>
            <tr>
              <td>Qodo PR-Agent</td>
              <td>Yes</td>
              <td className="hidden sm:table-cell">
                Open source (Apache-2.0), BYOK, Ollama supported
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
                Apache-2.0, no seat fees or license cost, BYOK
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
          axis, and for several of them it is not on offer. The Bugbot
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
          integration. PR-Agent itself is not the problem;
          &quot;self-host with a local model&quot; means budgeting for the
          glue, the model wiring, and the day a request silently goes to the
          wrong endpoint. That last failure mode is exactly what the rest of
          this article is about avoiding.
        </p>

        <h2>The Compose path with Postil and Ollama</h2>
        <p>
          Postil self-hosts the same stack we run hosted: Postgres, the web app,
          and the worker, through one Docker Compose file. The stack is
          Apache-2.0 with no seat fees or license cost; you pay for your own
          inference and infrastructure. The concrete path:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`git clone https://github.com/postil-dev/postil
cd postil
cp .env.example .env
# fill in: GitHub App credentials, webhook secret, a sealing key,
#          a session secret, and your LLM key. Each line in
#          .env.example explains its variable.

docker compose up -d db
docker compose run --rm web bun run db:migrate
docker compose run --rm web bun run operational:indexes
docker compose run --rm web bun run queue:activate-lock-generation
docker compose up -d`}</code>
        </pre>
        <p>
          Both the web app and the worker validate their configuration at boot:
          a missing or malformed variable stops the process with the variable
          name, what it is for, and an example value. Before you open a test PR,
          <code>postil doctor</code> checks the configured chain. Point it at
          Ollama with this block:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`POSTIL_API_BASE=http://ollama:11434/v1
MODEL_API_KEY=ollama        # any non-empty value
POSTIL_API_KEY=ollama
REVIEW_MODEL=qwen3-coder:30b`}</code>
        </pre>
        <p>
          Then run the doctor inside the worker container. It checks endpoint
          reachability separately from whether the configured model is ready to
          answer a request. This successful doctor transcript shows the checks
          it reports:
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`docker compose exec worker postil doctor

${doctorTranscript}`}</code>
        </pre>
        <p>
          This transcript was captured from the CLI against a loopback
          OpenAI-compatible endpoint. The URL and model name change for
          OpenRouter, Azure OpenAI, Ollama, or another compatible server, and
          key values are not printed.
        </p>

        <h2>Two provider interfaces, one worker</h2>
        <p>
          The Postil worker supports OpenAI-compatible chat completions and the
          Anthropic Messages API. The same binary points at Ollama, vLLM,
          LiteLLM, TGI, Azure OpenAI, OpenRouter, or Anthropic by selecting the
          request format and base URL. In CLI and self-hosted modes inference
          goes directly to your endpoint. Hosted BYOK uses the organization&apos;s
          configured provider and credentials.
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`# OpenRouter (default)
POSTIL_API_BASE=https://openrouter.ai/api/v1
MODEL_API_KEY=sk-or-v1-...
POSTIL_API_KEY=sk-or-v1-...

# Azure OpenAI
POSTIL_API_BASE=https://azure-resource.openai.azure.com/openai/v1
MODEL_API_KEY=azure-api-key
POSTIL_API_KEY=azure-api-key

# Ollama, vLLM, LiteLLM, TGI: same shape, different base URL`}</code>
        </pre>

        <h2>Models worth trying first</h2>
        <p>
          Start with one cheap model and one stronger model, then promote the
          cheapest one that preserves detection rate and silence on clean PRs.
          On OpenRouter, try DeepSeek V4 Pro or Kimi K2.6 as stronger
          defaults, and Qwen3 32B, Mistral Small 3.2 24B, or Gemma 3 27B for
          lower-cost or local-friendly runs. The maintained shortlist lives in
          the <Link href="/docs/models" className="text-rust underline">model catalog</Link>.
          Locally, use the largest coder model your hardware can serve reliably
          and verify it with <code>postil doctor</code> plus the live benchmark
          harness.
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
          Self-hosted plus Ollama means code never leaves your network. CLI mode
          with your own key sends code directly to the provider you chose, under
          your own data processing agreement. Hosted BYOK sends the diff through
          the Postil worker to your configured provider, and hosted default uses
          Postil&apos;s configured provider path. The forge coverage matters here
          too, because regulated buyers tend to run
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
          bearer. The worker&apos;s watchdog fails any review running longer than
          10 minutes, completes <code>postil/review</code> as neutral, and
          applies the organization merge-gate setting to{" "}
          <code>postil/gate</code>. A stuck review does not leave either check in
          progress indefinitely. The CLI binary is baked into the worker image
          at a pinned commit, so upgrading the reviewer is an image upgrade, not
          a runtime download from a network you may have deliberately cut off.
        </p>

        <h2>First review now, scale later</h2>
        <p>
          The wedge is simple. Self-hosting in this category is real but mostly
          locked behind an enterprise contract with a seat minimum, or left to a
          DIY open-source project. Postil&apos;s self-hosted stack is Apache-2.0
          with no seat fees or license cost, at any team size, with
          bring-your-own-key inference and a doctor that catches the
          misconfiguration that would otherwise make a local reviewer silently
          useless. No claim here that Postil detects more or better than
          CodeRabbit, Greptile, or PR-Agent: there is no comparative data to
          support one. The claim is about availability and the
          deployment model: a full AI code reviewer you can run on your own
          hardware through a scripted Compose path, with no 500-seat gate or
          sales call. The detailed how-to lives on the{" "}
          <Link href="/docs/self-hosted">self-hosted docs page</Link>.
        </p>

        <h2>Sources</h2>
        <ul>
          <li>
            <a
              href="https://aws.amazon.com/marketplace/pp/prodview-wkkkre4fgelwq"
              rel="noopener"
            >
              CodeRabbit AWS Marketplace listing
            </a>{" "}
            (self-hosted delivery, 500-user list price and minimum)
          </li>
          <li>
            <a href="https://github.com/qodo-ai/pr-agent" rel="noopener">
              Qodo PR-Agent (GitHub)
            </a>{" "}
            (Apache-2.0, multi-model)
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
            Apache-2.0, no seat fees or license cost, BYOK, with a scripted
            Compose path for Ollama.
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
