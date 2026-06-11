import type { Metadata } from "next";
import Link from "next/link";

import { Terminal } from "@/components/terminal";

export const metadata: Metadata = {
  title: "Install",
  description:
    "Install the Postil CLI in one line, run it in GitHub Actions, on GitLab, or via the hosted GitHub App. Same engine everywhere.",
  alternates: { canonical: "/install" },
  openGraph: {
    title: "Install Postil",
    description:
      "Install the Postil CLI in one line, run it in CI, on GitLab, or via the hosted GitHub App.",
    url: "https://postil.dev/install",
  },
};

export default function InstallPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Install</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        One engine. Start with the CLI.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        The CLI is the product. It runs locally, in CI, and behind the hosted
        app — the same pinned binary every time. Install it in one line and
        review your next diff before you push.
      </p>

      <div className="mt-14 space-y-12">
        {/* CLI — first, works today */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/40">01</p>
            <h2 className="serif-display mt-1 text-2xl">CLI</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Local reviews before you push. Apache-2.0. Works today.
            </p>
          </div>
          <div className="space-y-4">
            <Terminal title="install — one line">
              <code>
                <span className="t-dim"># install script (verifies the published SHA-256 over HTTPS)</span>{"\n"}
                <span className="t-dim">$</span> curl -fsSL https://postil.dev/install.sh | sh{"\n"}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              The script detects your OS and architecture, downloads the matching
              prebuilt binary from the GitHub release, verifies it against the
              SHA-256 checksum published alongside the release, and installs it to{" "}
              <code className="font-mono text-xs">~/.local/bin</code> (no{" "}
              <code className="font-mono text-xs">sudo</code> required). Inspect
              it first if you prefer:{" "}
              <code className="font-mono text-xs">
                curl -fsSL https://postil.dev/install.sh | less
              </code>
              .
            </p>
            <p className="text-sm text-ink-soft">
              The checksum is fetched over HTTPS from the same release, so it
              guards against a corrupted or in-transit-tampered download — not
              against a compromised release itself. Cryptographic artifact
              signing (cosign/minisign) is on the roadmap; until then, verify the
              published SHA-256 against the{" "}
              <a
                href="https://github.com/postil-dev/postil-cli/releases"
                className="text-rust underline"
                rel="noopener"
              >
                releases page
              </a>{" "}
              if you want a second source.
            </p>

            <Terminal title="install — package managers">
              <code>
                <span className="t-dim"># Rust toolchain, build from source</span>{"\n"}
                <span className="t-dim">$</span> cargo install postil-cli{"\n"}
                {"\n"}
                <span className="t-dim"># prebuilt binary via cargo-binstall (no compile)</span>{"\n"}
                <span className="t-dim">$</span> cargo binstall postil-cli{"\n"}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              Prebuilt targets: Linux <code className="font-mono text-xs">x86_64</code>{" "}
              and <code className="font-mono text-xs">aarch64</code>, macOS{" "}
              <code className="font-mono text-xs">arm64</code> and{" "}
              <code className="font-mono text-xs">x86_64</code>. A Homebrew tap
              is on the roadmap.
            </p>

            <Terminal title="first run">
              <code>
                <span className="t-dim">$</span> export OPENROUTER_API_KEY=sk-or-...{"\n"}
                <span className="t-dim">$</span> postil doctor{"\n"}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              Always run <code className="font-mono text-xs">postil doctor</code>{" "}
              before your first review. It checks the endpoint, key, and model and
              tells you exactly what is wrong if anything is:
            </p>

            <Terminal title="postil doctor">
              <code>
                <span className="t-dim">$</span> postil doctor{"\n"}
                {"\n"}
                <span className="t-green">ok</span>
                {"   binary    postil 1.0.0 (x86_64-unknown-linux-gnu)\n"}
                <span className="t-green">ok</span>
                {"   config    .postil.yaml found (fail-on: error)\n"}
                <span className="t-green">ok</span>
                {"   provider  openrouter — key present (env OPENROUTER_API_KEY)\n"}
                <span className="t-green">ok</span>
                {"   endpoint  https://openrouter.ai/api/v1 reachable (84 ms)\n"}
                <span className="t-green">ok</span>
                {"   model     deepseek/deepseek-v4-pro available\n"}
                <span className="t-green">ok</span>
                {"   forge     git remote: github.com/acme/payments\n"}
                {"\n"}
                <span className="t-dim">all checks passed · ready to review</span>
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              Then review your staged changes with{" "}
              <code className="font-mono text-xs">postil review --staged</code>.
              See the{" "}
              <Link href="/docs/quickstart" className="text-rust underline">
                quickstart
              </Link>{" "}
              and the{" "}
              <Link href="/docs/cli" className="text-rust underline">
                full command reference
              </Link>
              .
            </p>
          </div>
        </section>

        {/* GitHub Action */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/40">02</p>
            <h2 className="serif-display mt-1 text-2xl">GitHub Action</h2>
            <p className="mt-2 text-sm text-ink-soft">
              CI reviews with a SHA-pinned CLI.
            </p>
          </div>
          <div className="space-y-4">
            <Terminal title=".github/workflows/review.yml">
              <code>
                {`on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  postil:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write
    steps:
      - uses: actions/checkout@v4
      - uses: postil-dev/postil-action@v1
        with:
          cli-ref: `}
                <span className="t-rust">56253a6c8b2461f9d625001b130d09e13ff40963</span>
                {`
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}`}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              The action refuses anything but a full 40-character commit SHA for{" "}
              <code className="font-mono text-xs">cli-ref</code> — tags move, SHAs
              do not. The SHA above is current as of June 2026; check the{" "}
              <a
                href="https://github.com/postil-dev/postil-cli/releases"
                className="text-rust underline"
                rel="noopener"
              >
                releases page
              </a>{" "}
              for the latest blessed SHA.
            </p>
          </div>
        </section>

        {/* GitLab */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/40">03</p>
            <h2 className="serif-display mt-1 text-2xl">GitLab</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Same gate semantics on GitLab.com and self-managed.
            </p>
          </div>
          <div className="space-y-4">
            <p className="text-ink-soft">
              The CLI speaks GitLab through{" "}
              <code className="font-mono text-xs">--forge gitlab</code>, including
              self-managed instances via a custom base URL. It posts inline
              discussion notes on the merge request and reports the gate verdict
              through its exit code, which a CI job can fail on.
            </p>
            <Terminal title=".gitlab-ci.yml">
              <code>
                {`postil:
  image: ghcr.io/postil-dev/postil-cli:1
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - postil review
        --forge gitlab
        --mr `}
                <span className="t-rust">$CI_MERGE_REQUEST_IID</span>
                {`
  variables:
    POSTIL_GITLAB_TOKEN: $POSTIL_GITLAB_TOKEN   # project access token
    OPENROUTER_API_KEY: $OPENROUTER_API_KEY`}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              For a self-managed instance, add{" "}
              <code className="font-mono text-xs">
                --forge-url https://gitlab.example.com
              </code>
              . Full walkthrough:{" "}
              <Link href="/docs/gitlab" className="text-rust underline">
                GitLab guide
              </Link>
              .
            </p>
          </div>
        </section>

        {/* GitHub App */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/40">04</p>
            <h2 className="serif-display mt-1 text-2xl">Hosted GitHub App</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Zero-config reviews on every PR. Free during beta.
            </p>
          </div>
          <div>
            <p className="text-ink-soft">
              Install the App, pick repositories, open a pull request. Two
              check-runs appear; require{" "}
              <code className="font-mono text-sm">postil/gate</code> in branch
              protection when you are ready to make it binding. No keys leave
              your control: configure your own inference key per organization.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <a
                href="https://github.com/apps/postil"
                className="btn-primary"
                rel="noopener"
              >
                Install from GitHub
              </a>
              <span className="font-mono text-xs text-charcoal/60">
                hosted beta — free while in beta
              </span>
            </div>
            <p className="mt-4 text-sm text-ink-soft">
              Permissions requested: contents (read), pull requests (write),
              checks (write), metadata (read). Never write access to your code —
              see the{" "}
              <Link href="/security" className="text-rust underline">
                security page
              </Link>
              .
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
