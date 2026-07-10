import type { Metadata } from "next";
import Link from "next/link";
import { OsInstallTabs } from "@/components/os-install-tabs";

export const metadata: Metadata = {
  title: "Quickstart",
  description: "From zero to a first Postil review in a few minutes: CLI, Action, or hosted App.",
  alternates: { canonical: "/docs/quickstart" },
};

export default function QuickstartPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Quickstart</h1>
      <p className="mt-4 text-lg">
        Three ways in, one engine. Pick the one that matches where you want the
        review to happen.
      </p>

      <h2>1. Local CLI</h2>
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

      <h2>2. GitHub Actions</h2>
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
      - uses: postil-dev/postil-action@468923c378eacf9541a689f7d8c316ba4d5c6024 # example tested SHA
        with:
          cli-ref: 3776f251db771dd74615305d7c2b0bc21b9fb2df # postil-cli v0.1.2
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

      <h2>3. Hosted GitHub App</h2>
      <p>
        Install the App from the <Link href="/install">install page</Link>,
        select repositories, and open a pull request. Postil creates two
        check-runs (<code>postil/review</code> and <code>postil/gate</code>)
        and reviews the diff. Drafts are skipped until marked ready.
      </p>
      <p>
        The hosted app also answers <code>@postil</code> mentions: reply to one
        of its review comments, mention it in a PR or issue comment, and it
        responds in thread. It reviews and answers only: it never opens PRs or
        pushes commits. GitHub only today.
      </p>
      <p>
        To make the gate binding, require <code>postil/gate</code> in branch
        protection. See <Link href="/docs/gate">the gate</Link>.
      </p>

      <h2>Next steps</h2>
      <ul>
        <li>
          Tune thresholds and ignores in{" "}
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
