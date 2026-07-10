import type { Metadata } from "next";
import Link from "next/link";

import { ForgeInstallTabs } from "@/components/forge-install-tabs";
import { Terminal } from "@/components/terminal";
import { githubAppInstallUrl } from "@/lib/github-app";

export const metadata: Metadata = {
  title: "Install",
  description:
    "Install Postil for GitHub, GitLab, Bitbucket, or Azure DevOps. Use the hosted GitHub App or run the CLI in your forge's CI.",
  alternates: { canonical: "/install" },
  openGraph: {
    title: "Install Postil",
    description:
      "Start automatic pull request reviews on GitHub, GitLab, Bitbucket, or Azure DevOps.",
    url: "https://postil.dev/install",
    images: ["/opengraph-image"],
  },
};

export default function InstallPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Install</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        Choose your forge. Start reviewing pull requests.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        GitHub starts with the hosted App and no configuration. GitLab,
        Bitbucket, and Azure DevOps run the Postil CLI inside their own CI.
      </p>

      <div className="mt-10">
        <ForgeInstallTabs githubAppUrl={githubAppInstallUrl()} />
      </div>

      <section className="rule mt-12 grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
        <div>
          <p className="font-mono text-sm text-charcoal/70">CLI</p>
          <h2 className="serif-display mt-1 text-2xl">
            Installation and verification
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Shared by local workflows and every self-run forge integration.
            Apache-2.0.
          </p>
        </div>
        <div className="min-w-0 space-y-4">
          <Terminal title="install: one line">
            <code>
              <span className="t-dim">
                # install script (verifies the published SHA-256 over HTTPS)
              </span>
              {"\n"}
              <span className="t-dim">$</span> curl -fsSL
              https://postil.dev/install.sh | sh{"\n"}
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
            Release artifacts are signed with Sigstore keyless signing (cosign)
            via GitHub OIDC in release CI, alongside SHA-256 checksums. If{" "}
            <code className="font-mono text-xs">cosign</code> is installed, the
            script additionally verifies the keyless signature against the
            release workflow&apos;s certificate identity. There is no
            long-lived published key to manage. Without cosign it falls back to
            checksum verification only. Cross-check the published SHA-256 on
            the{" "}
            <a
              href="https://github.com/postil-dev/postil-cli/releases"
              className="text-rust underline"
              rel="noopener"
            >
              releases page
            </a>{" "}
            if you want a second source.
          </p>

          <Terminal title="install: build from source">
            <code>
              <span className="t-dim">
                # Rust toolchain, build from the repository
              </span>
              {"\n"}
              <span className="t-dim">$</span> cargo install --git
              https://github.com/postil-dev/postil-cli --locked{"\n"}
            </code>
          </Terminal>
          <p className="text-sm text-ink-soft">
            Prebuilt targets: Linux{" "}
            <code className="font-mono text-xs">x86_64</code> and{" "}
            <code className="font-mono text-xs">aarch64</code>, macOS{" "}
            <code className="font-mono text-xs">arm64</code> and{" "}
            <code className="font-mono text-xs">x86_64</code>.
          </p>

          <Terminal title="first run">
            <code>
              <span className="t-dim">$</span> export MODEL_API_KEY=sk-or-...{"\n"}
              <span className="t-dim">$</span> export
              POSTIL_API_KEY=&quot;$MODEL_API_KEY&quot;{"\n"}
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

          <Terminal title="postil doctor">
            <code>
              <span className="t-dim">$</span> postil doctor{"\n"}
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
    </div>
  );
}
