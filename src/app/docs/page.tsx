import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Docs",
  description: "Postil documentation: quickstart, configuration, the gate, self-hosting, and the envelope schema.",
  alternates: { canonical: "/docs" },
};

const CARDS = [
  {
    href: "/docs/quickstart",
    title: "Quickstart",
    body: "Install the CLI, review your first staged diff, and wire up the GitHub App or Action.",
  },
  {
    href: "/docs/config",
    title: "Configuration",
    body: "The full .postil.yaml reference, including CodeRabbit config translation (reads .coderabbit.yaml).",
  },
  {
    href: "/docs/cli",
    title: "CLI reference",
    body: "Every command and flag: review, respond, plan, config, init, doctor, hook, plus environment variables and exit codes.",
  },
  {
    href: "/docs/gate",
    title: "The gate",
    body: "postil/gate semantics, fail-on thresholds, and how to require it in branch protection.",
  },
  {
    href: "/docs/plan",
    title: "postil plan",
    body: "Dry-run a config change against stored envelopes before deploying it. No model calls.",
  },
  {
    href: "/docs/envelope",
    title: "Envelope schema",
    body: "The JSON contract between the CLI and everything else: findings, counts, gate, usage.",
  },
  {
    href: "/docs/content-policy",
    title: "Content policy",
    body: "Opt-in review of prose in the diff: fabricated claims, AI-authorship residue, and the built-in baseline.",
  },
  {
    href: "/docs/gitlab",
    title: "GitLab",
    body: "Run Postil on GitLab.com and self-managed: CI job, project tokens, and merge-request review.",
  },
  {
    href: "/docs/self-hosted",
    title: "Self-hosted",
    body: "Docker Compose quickstart in under 15 minutes, with OpenRouter, Azure, and Ollama examples.",
  },
  {
    href: "/docs/models",
    title: "Models",
    body: "Recommended OpenRouter and local models, token-cost math, and how to run the live model benchmark.",
  },
] as const;

export default function DocsIndexPage() {
  return (
    <div>
      <h1 className="serif-display text-4xl">Documentation</h1>
      <p className="prose-postil mt-4 text-lg">
        Postil is one Rust binary (<code>postil</code>) and a thin control
        plane around it. These pages cover everything from the first local
        review to running the whole stack on your own hardware.
      </p>
      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {CARDS.map((card) => (
          <Link key={card.href} href={card.href} className="card block p-5 transition-colors hover:border-gate">
            <p className="serif-display text-xl">{card.title}</p>
            <p className="mt-2 text-sm text-ink-soft">{card.body}</p>
          </Link>
        ))}
      </div>
      <div className="prose-postil mt-12">
        <h2>The short version</h2>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`# local
curl -fsSL https://postil.dev/install.sh | sh
# or: cargo install --git https://github.com/postil-dev/postil-cli --locked
postil doctor            # verify endpoint, key, and model
postil review --staged

# CI (GitHub Actions) — @v1 resolves after the first tagged release
- uses: postil-dev/postil-action@468923c378eacf9541a689f7d8c316ba4d5c6024 # main
  with:
    cli-ref: 87f4bf08b63712d3600030a7c458f0b790cfc0d5 # postil-cli v0.1.1

# hosted
Install the GitHub App; reviews start on the next PR.`}</code>
        </pre>
        <p>
          Exit codes: <code>0</code> clean or below the gate threshold,{" "}
          <code>1</code> gate-failing findings, <code>2</code> operational
          error. Postil never reports an operational error as a pass.
        </p>
      </div>
    </div>
  );
}
