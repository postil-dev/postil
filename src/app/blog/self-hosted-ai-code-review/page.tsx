import type { Metadata } from "next";
import Link from "next/link";

import { doctorTranscript } from "@/data/transcripts";

export const metadata: Metadata = {
  title: "Self-hosted AI code review without the 500-seat enterprise gate",
  description:
    "CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer it at all. Run an Apache-2.0 AI code reviewer locally with Ollama, with no seat fees or license cost.",
  alternates: { canonical: "/blog/self-hosted-ai-code-review" },
};

export default function SelfHostedBlogPage() {
  return (
    <article className="prose-postil mx-auto max-w-2xl">
      <h1 className="serif-display text-4xl text-charcoal">
        Self-hosted AI code review without the 500-seat enterprise gate
      </h1>
      <p className="mt-4 text-lg text-ink-soft">
        CodeRabbit gates self-hosting behind 500 seats; most rivals don't offer
        it at all. Postil runs Apache-2.0 licensed locally with zero seat fees
        or license cost, with your own inference endpoint.
      </p>

      <p className="mt-8 text-sm text-ink-soft">
        Publish date: 2026-07-03 • Read time: 6 minutes
      </p>

      <h2>The seat gate is an infrastructure tax</h2>
      <p>
        Modern AI code review services make most of their revenue from seat
        licenses (per-developer pricing). CodeRabbit is explicit: free for
        public repos, $600/year per seat for private repositories. GitHub
        Copilot is $200/year per seat. Greptile is{" "}
        <a href="https://www.greptile.com/pricing#enterprise" rel="noopener">
          per-seat enterprise only
        </a>
        . Even self-hosted offerings gate it behind seat counts: CodeRabbit's
        self-hosted option is 500 seats minimum.
      </p>
      <p>
        A 10-person engineering team reviewing each other's code hits the $3000
        yearly floor, every year. A 50-person team is $30,000/year. At startup
        scale (500 engineers) you are not even allowed to self-host: CodeRabbit
        sends you to enterprise sales.
      </p>
      <p>
        The business model is sound for the vendors—they charge per consumer. The
        cost structure is awful for customers who want ownership.
      </p>

      <h2>Postil offers a different model: run it yourself</h2>
      <p>
        Postil is Apache-2.0 licensed with zero seat gates. You run the
        reviewer in your CI with your inference endpoint of choice: Ollama on a
        local server, vLLM on a GPU cluster, an Azure OpenAI deployment, or
        OpenRouter's API. You own the code (all 4000 lines of it), the
        configuration, and the flow of your pull requests and inferences. No
        vendor lock-in. No seat count. No year-over-year surprise costs. No
        enterprise sales flow.
      </p>

      <p>
        The Postil architecture is:
      </p>
      <ol>
        <li>
          The reviewer CLI: a single{" "}
          <code className="font-mono text-sm">postil</code> binary you run in CI
          or locally.
        </li>
        <li>
          The inference endpoint: you choose (Ollama, Azure OpenAI, OpenRouter,
          etc). Postil speaks OpenAI-compatible chat completions, so you point
          at any provider or self-hosted model server, or self-host both.
        </li>
        <li>
          The forges: GitHub, GitLab, Bitbucket, Azure DevOps. Postil is a
          reviewer, not a platform.
        </li>
      </ol>

      <h2>Getting started: CLI self-hosted</h2>
      <p>
        Postil runs in CI the same way you would run any linter. Install the
        CLI, set an API key and model choice, and call{" "}
        <code className="font-mono text-sm">postil review</code> in your job.
        Nothing goes to postil.dev. Diffs go only to your inference endpoint
        under your configured provider account.
      </p>

      <p>
        Before the first review, run{" "}
        <code className="font-mono text-xs">postil doctor</code> to verify your
        setup. It is a health check that validates your git work tree, API key,
        configured model, and the endpoint reachability separately from whether
        the configured model is ready to answer a request. This successful
        doctor transcript shows the checks it reports:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`docker compose exec worker postil doctor

${doctorTranscript}`}</code>
      </pre>
      <p>
        The output confirms config resolution, endpoint connectivity, and readiness.
        Your provider URL and model name will differ; API key values are never printed.
      </p>

      <h2>Why &quot;OpenAI-compatible&quot; is the whole trick</h2>
      <p>
        The structural reason there is no seat gate is that there is no
        customer-facing inference meter. The Postil worker speaks plain
        OpenAI-compatible chat completions, against{" "}
        <code>POST {"{base}"}/chat/completions</code>. The same binary points
        at Ollama, vLLM, LiteLLM, TGI, Azure OpenAI, or OpenRouter by changing
        one base URL. In CLI and self-hosted modes there is no proxy in the
        middle: inference goes to your endpoint under your provider account.
        Hosted BYOK routes through the worker to your configured provider, and
        hosted Team reviews are included by default.
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`# OpenRouter (default)
POSTIL_API_BASE=https://openrouter.ai/api/v1
MODEL_API_KEY=sk-or-v1-...
REVIEW_MODEL=deepseek/deepseek-v4-pro

# Ollama (local)
POSTIL_API_BASE=http://ollama:11434/v1
REVIEW_MODEL=mistral:7b

# Azure OpenAI
POSTIL_API_BASE=https://resource-name.openai.azure.com/openai/v1
REVIEW_MODEL=gpt-4`}</code>
      </pre>
      <p>
        Switch endpoints by resetting one variable and redeploying. Switch
        models the same way. The only customer data is your diffs and the
        inferences Postil runs, owned by you or your inference provider per
        your contract with them (not Postil).
      </p>

      <h2>Hosting the full stack yourself</h2>
      <p>
        For organizations that want the full bot experience—automated inline PR
        comments, the <code>@postil</code> mention bot, a dashboard, and
        webhook-driven reviews—Postil is also a full-stack app. Clone the repo,
        fill in your environment variables (GitHub App credentials, your
        inference endpoint, a Postgres URL), run Docker Compose, and open a PR.
        The app is the same one running postil.dev: web, worker, and database.
      </p>
      <p>
        If your inference must stay on-prem: run the stack behind your firewall
        and point it at your Ollama, vLLM, or TGI endpoint. If you want to
        outsource inference: point it at OpenRouter, Azure OpenAI, or any
        OpenAI-compatible provider and you pay them direct, with no markup from
        Postil.
      </p>

      <h2>What about the reviews themselves?</h2>
      <p>
        Postil&apos;s findings are the inference output from your model: they
        are not Postil-curated detections (the way that CodeRabbit hardcodes
        specific vulnerability or pattern matching logic). Postil teaches your
        model (via the prompt and any org-specific docs you provide) to do code
        review on your terms. If you pick Ollama&apos;s latest open model and
        run it locally, the findings are from that model; if you pick a
        proprietary model from OpenRouter or Azure, they are from that model,
        under your usage terms with your provider.
      </p>
      <p>
        This is a feature: you are not locked into Postil&apos;s findings
        policies. You control what your reviewers see and what they act on. You
        can toggle content-policy checks on or off, swap models without
        migrating platform logic, and retry reviews with tweaked prompts or
        different models without asking vendor permission.
      </p>

      <h2>The seat count is not a product feature</h2>
      <p>
        Postil does not have seats because Postil does not have a meter: it is
        not a hosted API for review-as-a-service. The reviewer is a binary you
        run, pointing at an inference provider you choose and own. There is no
        "Postil account" to provision, no API rate limit per user per month, no
        seat licensing, and no infrastructure to pay for a seat to exist. You
        run Postil's code, your inference, your forge, and you own all of it.
      </p>
      <p>
        This is a better business model for customers and a better software
        architecture for the problem space.
      </p>
    </article>
  );
}
