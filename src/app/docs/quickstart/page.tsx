import type { Metadata } from "next";
import Link from "next/link";
import { OsInstallTabs } from "@/components/os-install-tabs";
import { githubAppInstallUrl } from "@/lib/github-app";
import {
  PUBLIC_POSTIL_ACTION_SHA,
  PUBLIC_POSTIL_CLI_RELEASE,
  PUBLIC_POSTIL_CLI_SHA,
} from "@/lib/public-cli-example";

export const metadata: Metadata = {
  title: "Quickstart",
  description:
    "Install the GitHub App with a hosted trial, then add the CLI and Action for local reviews and merge gating.",
  alternates: { canonical: "/docs/quickstart" },
};

export default function QuickstartPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Quickstart</h1>
      <p className="mt-4 text-lg">
        Start with the GitHub App. Hosted trials cover up to three organizations
        per installing identity; BYOK covers additional organizations. It
        reviews new non-draft pull requests after setup. Add the CLI and GitHub
        Action for local reviews and merge blocking.
      </p>

      <h2>1. GitHub App</h2>
      <p>
        Install the App and select all repositories or a chosen set. Your hosted
        30-day trial starts automatically without a card. Postil reviews new
        non-draft pull requests in those repositories after setup. You can use
        your own provider from organization settings. Private reviews pause when
        the trial ends unless a paid plan is active.
      </p>
      <p>
        Draft pull requests are skipped until marked ready. Existing open pull
        requests are not reviewed retroactively unless a review is requested
        again. You can disable individual repositories from the organization
        dashboard.
      </p>
      <p>
        <a
          href={githubAppInstallUrl()}
          className="not-prose btn-primary inline-block"
        >
          Install the GitHub App
        </a>
      </p>
      <p>
        The GitHub App also handles <code>@postil</code> mentions. Exact review
        commands on a pull request run the structured reviewer; questions get
        a compact thread reply. It reviews and answers only: it never opens PRs
        or pushes commits. GitHub only today.
      </p>

      <h2>2. Local CLI</h2>
      <p>
        Install the binary and point it at an OpenAI-compatible endpoint. The
        default is OpenRouter.
      </p>
      <OsInstallTabs />
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`# review what you are about to commit
postil review --staged

# review a branch against main
postil review --base main`}</code>
      </pre>
      <p>
        On a clean diff the command prints nothing of substance and exits{" "}
        <code>0</code>. Findings print with severity, path, line, confidence,
        and kind; gate-failing findings exit <code>1</code>.
      </p>
      <p>
        Verify your setup before the first real review with{" "}
        <code>postil doctor</code>: it checks the endpoint, key, and model and
        reports exactly what is wrong if anything is.
      </p>

      <h2>3. GitHub Actions</h2>
      <p>
        The composite action installs a CLI pinned to a full 40-character
        commit SHA and runs the same review in CI. Pin the action itself to a
        commit SHA as well:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`name: review
on:
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
      - uses: postil-dev/postil-action@${PUBLIC_POSTIL_ACTION_SHA} # tested pair
        with:
          cli-ref: ${PUBLIC_POSTIL_CLI_SHA}
          cli-release: ${PUBLIC_POSTIL_CLI_RELEASE}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          MODEL_API_KEY: \${{ secrets.MODEL_API_KEY }}
          POSTIL_API_KEY: \${{ secrets.MODEL_API_KEY }}`}</code>
      </pre>
      <p>
        The action SHA above is an example full commit SHA, and{" "}
        <code>cli-ref</code> pins the postil-cli release commit. Pick full SHAs
        you have verified from the{" "}
        <a
          href="https://github.com/postil-dev/postil-action"
          rel="noopener"
        >
          postil-action repository
        </a>{" "}
        and the{" "}
        <a
          href="https://github.com/postil-dev/postil-cli"
          rel="noopener"
        >
          postil-cli repository
        </a>{" "}
        before updating. The action refuses anything but a full 40-character
        commit SHA for <code>cli-ref</code>: tags move, SHAs do not.
      </p>
      <p>
        As a recommended bonus, make review failures block merges by requiring{" "}
        <code>postil/gate</code> in branch protection. See{" "}
        <Link href="/docs/gate">the gate</Link>.
      </p>

      <h2>Next steps</h2>
      <ul>
        <li>
          Optionally tune thresholds and ignores in{" "}
          <Link href="/docs/config">.postil.yaml</Link>, or keep your existing{" "}
          <code>.coderabbit.yaml</code>; Postil reads it.
        </li>
        <li>
          Preview any config change with{" "}
          <Link href="/docs/plan">postil plan</Link> before deploying it.
        </li>
        <li>
          Run the whole stack yourself:{" "}
          <Link href="/docs/self-hosted">self-hosted guide</Link>.
        </li>
      </ul>
    </div>
  );
}
