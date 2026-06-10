import type { Metadata } from "next";
import Link from "next/link";

import { Terminal } from "@/components/terminal";

export const metadata: Metadata = {
  title: "Install",
  description: "Install the Postil GitHub App, the CLI, or the GitHub Action.",
};

export default function InstallPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Install</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        Three ways to run the same engine.
      </h1>

      <div className="mt-14 space-y-12">
        {/* GitHub App */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/40">01</p>
            <h2 className="serif-display mt-1 text-2xl">GitHub App</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Hosted reviews on every PR. Free during beta.
            </p>
          </div>
          <div>
            <p className="text-ink-soft">
              Install the App, pick repositories, open a pull request. Two
              check-runs appear; require{" "}
              <code className="font-mono text-sm">postil/gate</code> in branch
              protection when you are ready to make it binding.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <a
                href="https://github.com/apps/postil"
                className="btn-primary"
                rel="noopener"
              >
                Install from GitHub
              </a>
              <span className="font-mono text-xs text-charcoal/50">
                marketplace listing pending approval — link may 404 until then
              </span>
            </div>
            <p className="mt-4 text-sm text-ink-soft">
              Permissions requested: contents (read), pull requests (write),
              checks (write), metadata (read). Never write access to your code.
            </p>
          </div>
        </section>

        {/* CLI */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/40">02</p>
            <h2 className="serif-display mt-1 text-2xl">CLI</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Local reviews before you push. Apache-2.0.
            </p>
          </div>
          <div className="space-y-4">
            <Terminal title="install">
              <code>
                <span className="t-dim"># from source (Rust toolchain)</span>{"\n"}
                <span className="t-dim">$</span> cargo install postil-cli{"\n"}
                {"\n"}
                <span className="t-dim"># prebuilt binaries (Linux x86_64/arm64, macOS)</span>{"\n"}
                <span className="t-dim">$</span> curl -fsSL https://github.com/postil-dev/postil-cli/releases/latest/download/postil-$(uname -m)-$(uname -s | tr A-Z a-z) -o /usr/local/bin/postil{"\n"}
                <span className="t-dim">$</span> chmod +x /usr/local/bin/postil{"\n"}
                {"\n"}
                <span className="t-dim">$</span> export OPENROUTER_API_KEY=sk-or-...{"\n"}
                <span className="t-dim">$</span> postil review --staged
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              Run <code className="font-mono text-xs">postil doctor</code>{" "}
              first to verify endpoint, key, and model. See the{" "}
              <Link href="/docs/quickstart" className="text-rust underline">
                quickstart
              </Link>
              .
            </p>
          </div>
        </section>

        {/* Action */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/40">03</p>
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
                <span className="t-rust">{"<40-hex postil-cli commit SHA>"}</span>
                {`
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}`}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              The action refuses anything but a full 40-character commit SHA
              for <code className="font-mono text-xs">cli-ref</code> — tags
              move, SHAs do not.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
