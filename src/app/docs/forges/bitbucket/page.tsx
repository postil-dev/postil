import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Bitbucket",
  description:
    "Run Postil on Bitbucket Cloud and Data Center: app passwords, pipeline setup, pull-request review, and the gate verdict via exit code.",
  alternates: { canonical: "/docs/forges/bitbucket" },
};

export default function BitbucketForgePage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Bitbucket</h1>
      <p className="mt-4 text-lg">
        Postil reviews Bitbucket pull requests through the same engine it
        uses for GitHub and GitLab. Support is best effort: shipped, tested,
        and configured with the same token-plus-base-URL pattern as every
        other forge. The hosted app does not reach Bitbucket; you run the
        CLI in your own pipeline with your own inference key.
      </p>

      <h2>1. Create credentials</h2>
      <p>
        Set <code>BITBUCKET_TOKEN</code>. Bitbucket Cloud repository, project,
        or workspace access tokens work directly; if you are using an app
        password instead, also set <code>BITBUCKET_USER</code> so the token is
        sent as basic auth rather than a bearer token. Add your inference key
        (for example <code>OPENROUTER_API_KEY</code>) as a repository
        variable too.
      </p>

      <h2>2. Add the pipeline step</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`pipelines:
  pull-requests:
    '**':
      - step:
          name: postil review
          image: debian:bookworm-slim
          script:
            - apt-get update && apt-get install -y curl ca-certificates
            - curl -fsSL https://postil.dev/install.sh | sh
            - export PATH="$HOME/.local/bin:$PATH"
            - postil review --forge bitbucket
                --repo $BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG
                --pr $BITBUCKET_PR_ID`}</code>
      </pre>
      <p>
        A gate-failing review exits <code>1</code> and fails the step; a
        clean review exits <code>0</code> and posts nothing — see{" "}
        <Link href="/docs/exit-codes">exit codes</Link>. Mark the step{" "}
        <strong>required</strong> in the repository&apos;s branch restrictions
        to make the gate binding.
      </p>

      <h2>3. Bitbucket Data Center</h2>
      <p>
        For self-hosted Bitbucket Data Center, point the CLI at your instance
        with <code>BITBUCKET_API_URL</code>:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`export BITBUCKET_TOKEN=...
export BITBUCKET_API_URL=https://bitbucket.example.com/rest/api/1.0
postil review --forge bitbucket --repo project/repo --pr 7`}</code>
      </pre>

      <h2>Local review against a Bitbucket PR</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`export BITBUCKET_TOKEN=...          # set BITBUCKET_USER too for an app password
postil review --forge bitbucket --repo workspace/repo --pr 7`}</code>
      </pre>

      <h2>Parity and limits</h2>
      <ul>
        <li>
          Same gate thresholds, envelope schema, and exit codes as every other
          forge — see the <Link href="/docs/cli">CLI reference</Link> and{" "}
          <Link href="/docs/exit-codes">exit codes</Link>.
        </li>
        <li>
          <code>postil respond</code> (the <code>@postil</code> interactive
          bot) supports <code>--pr</code> only. Bitbucket&apos;s issue
          tracker is a separate, often-disabled product with a different API
          shape Postil does not talk to yet — pointing <code>respond</code> at{" "}
          <code>--issue</code> on Bitbucket returns an error rather than
          silently doing nothing.
        </li>
        <li>
          The hosted Postil app is GitHub-only today; on Bitbucket you run the
          CLI in your own pipeline.
        </li>
        <li>
          See the <Link href="/docs/forges">forges overview</Link> for
          GitHub, GitLab, and Azure DevOps.
        </li>
      </ul>
    </div>
  );
}
