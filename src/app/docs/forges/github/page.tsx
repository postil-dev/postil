import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GitHub",
  description:
    "Run Postil on GitHub and GHES: the GitHub App, GitHub Actions, personal access tokens, and the @postil interactive bot.",
  alternates: { canonical: "/docs/forges/github" },
};

export default function GitHubForgePage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">GitHub</h1>
      <p className="mt-4 text-lg">
        GitHub is the default forge and the only one the hosted app at{" "}
        <Link href="/">postil.dev</Link> talks to today. It is also a
        first-class CLI target: run it yourself in Actions, another CI, or
        locally with no dependency on the hosted platform.
      </p>

      <h2>Hosted app</h2>
      <p>
        Install the GitHub App and reviews start on the next PR: inline
        comments, both check-runs (<code>postil/review</code>,{" "}
        <code>postil/gate</code>), and the <code>@postil</code> interactive
        bot on issues and pull requests. No CI job to write.
      </p>

      <h2>Run it yourself</h2>
      <p>
        Use{" "}
        <a href="https://github.com/postil-dev/postil-action">
          postil-action
        </a>{" "}
        in GitHub Actions, or call the binary directly:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`export GITHUB_TOKEN=...            # repo scope, or a fine-grained token with
                                    # pull requests: write, checks: write
export MODEL_API_KEY=...
export POSTIL_API_KEY="$MODEL_API_KEY"

postil review --repo owner/name --pr 123   # posts inline comments + both check-runs`}</code>
      </pre>
      <p>
        A gate-failing review exits <code>1</code>; a clean review exits{" "}
        <code>0</code> and posts nothing. See{" "}
        <Link href="/docs/exit-codes">exit codes</Link> for what CI should do
        with each. Mark <code>postil/gate</code> required in branch protection
        — see <Link href="/docs/gate">the gate</Link>.
      </p>

      <h2>GitHub Enterprise Server</h2>
      <p>
        Point the CLI at your instance with <code>GITHUB_API_URL</code>:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`export GITHUB_TOKEN=...
export GITHUB_API_URL=https://ghes.example.com/api/v3
postil review --repo owner/name --pr 123`}</code>
      </pre>
      <p>
        Token, scopes, and gate semantics are identical to github.com. The
        hosted app does not reach GHES; run the CLI in your own CI.
      </p>

      <h2>The @postil bot</h2>
      <p>
        Mention <code>@postil</code> in a pull-request or issue comment, reply
        to one of its review comments, or open an issue that mentions it. The
        hosted bot replies automatically; the CLI equivalent is:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`postil respond --repo owner/name --pr 123 --comment "@postil is this safe?"
postil respond --repo owner/name --issue 45 --comment "@postil what's the likely cause?"
# Automation should pass the text via env instead (argv is visible in \`ps\`):
POSTIL_COMMENT="@postil is this safe?" postil respond --repo owner/name --pr 123`}</code>
      </pre>
      <p>
        GitHub covers both issues and pull requests for <code>respond</code> —
        its issues API handles both, so <code>--pr</code> and{" "}
        <code>--issue</code> both work. Postil reviews and answers only; it
        never opens PRs or pushes commits.
      </p>

      <h2>SARIF</h2>
      <p>
        <code>--sarif &lt;path&gt;</code> writes SARIF 2.1.0 for GitHub code
        scanning ingestion alongside the review:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`postil review --repo owner/name --pr 123 --sarif postil.sarif`}</code>
      </pre>

      <h2>Other forges</h2>
      <p>
        See the <Link href="/docs/forges">forges overview</Link> for GitLab,
        Bitbucket, and Azure DevOps, and the{" "}
        <Link href="/docs/cli">CLI reference</Link> for every flag and
        environment variable.
      </p>
    </div>
  );
}
