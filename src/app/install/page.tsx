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
    images: ["/opengraph-image"],
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
            <p className="font-mono text-sm text-charcoal/70">01</p>
            <h2 className="serif-display mt-1 text-2xl">CLI</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Local reviews before you push. Apache-2.0. Works today.
            </p>
          </div>
          <div className="min-w-0 space-y-4">
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
              Release artifacts are signed with Sigstore keyless signing
              (cosign) via GitHub OIDC in release CI, alongside SHA-256
              checksums. If <code className="font-mono text-xs">cosign</code> is
              installed, the script additionally verifies the keyless signature
              against the release workflow&apos;s certificate identity — there
              is no long-lived published key to manage. Without cosign it falls
              back to checksum verification only. Cross-check the published
              SHA-256 on the{" "}
              <a
                href="https://github.com/postil-dev/postil-cli/releases"
                className="text-rust underline"
                rel="noopener"
              >
                releases page
              </a>{" "}
              if you want a second source.
            </p>

            <Terminal title="install — build from source">
              <code>
                <span className="t-dim"># Rust toolchain, build from the repository</span>{"\n"}
                <span className="t-dim">$</span> cargo install --git https://github.com/postil-dev/postil-cli --locked{"\n"}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              Prebuilt targets: Linux <code className="font-mono text-xs">x86_64</code>{" "}
              and <code className="font-mono text-xs">aarch64</code>, macOS{" "}
              <code className="font-mono text-xs">arm64</code> and{" "}
              <code className="font-mono text-xs">x86_64</code>.
            </p>

            <Terminal title="first run">
              <code>
                <span className="t-dim">$</span> export OPENROUTER_API_KEY=sk-or-...{"\n"}
                <span className="t-dim">$</span> postil doctor{"\n"}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              Always run <code className="font-mono text-xs">postil doctor</code>{" "}
              before your first review. It checks the resolved config, the git
              work tree, your API key, a live probe of the model endpoint, and
              any forge tokens, and tells you exactly what is wrong if anything
              is:
            </p>

            {/* Illustrative demo output: the five checks, their order, and the
                [ok  ]/[FAIL] format match the CLI; the endpoint detail is from a
                real reachable run, but the exact strings are example values. */}
            <Terminal title="postil doctor">
              <code>
                <span className="t-dim">$</span> postil doctor{"\n"}
                <span className="t-green">[ok  ]</span>
                {" config           loaded from .postil.yaml (model: deepseek/deepseek-v4-pro, gate failOn: error, minConfidence: 0.6)\n"}
                <span className="t-green">[ok  ]</span>
                {" git              inside a git work tree\n"}
                <span className="t-green">[ok  ]</span>
                {" api key          POSTIL_API_KEY or OPENROUTER_API_KEY is set (value not shown)\n"}
                <span className="t-green">[ok  ]</span>
                {" model endpoint   https://openrouter.ai/api/v1 answered for model deepseek/deepseek-v4-pro\n"}
                <span className="t-green">[ok  ]</span>
                {" forge tokens     GITHUB_TOKEN set, GITLAB_TOKEN unset (only needed for remote review)\n"}
                {"\n"}
                <span className="t-dim">postil doctor: ready.</span>
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
            <p className="font-mono text-sm text-charcoal/70">02</p>
            <h2 className="serif-display mt-1 text-2xl">GitHub Action</h2>
            <p className="mt-2 text-sm text-ink-soft">
              CI reviews with a SHA-pinned CLI.
            </p>
          </div>
          <div className="min-w-0 space-y-4">
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
                <span className="t-rust">87f4bf08b63712d3600030a7c458f0b790cfc0d5</span>
                {`
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}`}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              The action refuses anything but a full 40-character commit SHA for{" "}
              <code className="font-mono text-xs">cli-ref</code> — tags move, SHAs
              do not. The SHA above is the current blessed CLI ref; check the{" "}
              <a
                href="https://github.com/postil-dev/postil-cli"
                className="text-rust underline"
                rel="noopener"
              >
                postil-cli repository
              </a>{" "}
              for the latest blessed SHA.
            </p>
          </div>
        </section>

        {/* GitLab */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/70">03</p>
            <h2 className="serif-display mt-1 text-2xl">GitLab</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Same gate semantics on GitLab.com and self-managed.
            </p>
          </div>
          <div className="min-w-0 space-y-4">
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
  image: debian:bookworm-slim
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  before_script:
    - apt-get update && apt-get install -y curl ca-certificates
    - curl -fsSL https://postil.dev/install.sh | sh
    - export PATH="$HOME/.local/bin:$PATH"
  script:
    - postil review
        --forge gitlab
        --repo $CI_PROJECT_PATH
        --pr `}
                <span className="t-rust">$CI_MERGE_REQUEST_IID</span>
                {`
  variables:
    GITLAB_TOKEN: $GITLAB_TOKEN   # project access token
    OPENROUTER_API_KEY: $OPENROUTER_API_KEY`}
              </code>
            </Terminal>
            <p className="text-sm text-ink-soft">
              For a self-managed instance, set{" "}
              <code className="font-mono text-xs">
                GITLAB_API_URL=https://gitlab.example.com/api/v4
              </code>
              . Full walkthrough:{" "}
              <Link href="/docs/forges/gitlab" className="text-rust underline">
                GitLab guide
              </Link>
              .
            </p>
          </div>
        </section>

        {/* GitHub App */}
        <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
          <div>
            <p className="font-mono text-sm text-charcoal/70">04</p>
            <h2 className="serif-display mt-1 text-2xl">Hosted GitHub App</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Zero-config reviews on every PR. Free during beta.
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-ink-soft">
              The App installs in a click: pick repositories, open a pull
              request, and two check-runs appear; require{" "}
              <code className="font-mono text-sm">postil/gate</code> in branch
              protection when you are ready to make it binding. No keys leave
              your control unless you choose managed inference: configure your
              own key per organization or let Postil include model spend on the
              same invoice. The App also answers{" "}
              <code className="font-mono text-sm">@postil</code> mentions on PRs
              and issues; review and answer only, it never opens PRs or pushes
              commits.
            </p>
            <p className="mt-3 text-sm text-ink-soft">
              Hosted access is rolling out as a best-effort beta. The CLI,
              GitHub Action, and self-hosted stack use the same review engine.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <Link href="/docs/self-hosted" className="btn-primary">
                Run it yourself
              </Link>
              <span className="font-mono text-xs text-charcoal/70">GitHub App beta</span>
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
