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
    body: "Install the hosted GitHub App for immediate reviews with no configuration, then add local and CI workflows if you need them.",
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
    href: "/docs/exit-codes",
    title: "Exit codes",
    body: "The precise CLI contract: 0 clean or below the gate threshold, 1 gate-failing findings, 2 operational error.",
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
    body: "Default-on review of prose with a built-in baseline, repo-specific extensions, and an explicit opt-out.",
  },
  {
    href: "/docs/forges",
    title: "Forges",
    body: "GitHub, GitLab, Bitbucket, and Azure DevOps: auth per forge and what each one supports.",
  },
  {
    href: "/docs/self-hosted",
    title: "Self-hosted",
    body: "Run the CLI in your own CI with your own key, or host the full web + worker control plane yourself.",
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
        Install the hosted GitHub App to review new pull requests immediately.
        These pages also cover the open-source CLI, CI merge gating,
        configuration, and running the whole stack on your own hardware.
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
          <code>{`# hosted: install the GitHub App and choose repositories
# every new non-draft PR is reviewed with no configuration

# local
curl -fsSL https://postil.dev/install.sh | sh
# or: cargo install --git https://github.com/postil-dev/postil-cli --locked
postil doctor            # verify endpoint, key, and model
postil review --staged

# CI (GitHub Actions)
- uses: postil-dev/postil-action@7451c6380dba0da92758f7ddcdf383d1501e57b2 # example tested SHA
  with:
    cli-ref: 3f3c48b85019e9a0d7fbcde9cb0d63c186ca8401 # postil-cli v0.2.1`}</code>
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
