import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Azure DevOps",
  description:
    "Run Postil on Azure DevOps Services and Server: personal access tokens, pipeline setup, pull-request review, and the gate verdict via exit code.",
  alternates: { canonical: "/docs/forges/azure" },
};

export default function AzureForgePage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Azure DevOps</h1>
      <p className="mt-4 text-lg">
        Postil reviews Azure DevOps pull requests through the same engine it
        uses for GitHub and GitLab. Support is best effort: shipped, tested,
        and configured with the same token-plus-base-URL pattern as every
        other forge. The hosted app does not reach Azure DevOps; you run the
        CLI in your own pipeline with your own inference key.
      </p>

      <h2>1. Create a personal access token</h2>
      <p>
        Create a PAT scoped to <strong>Code (Read &amp; Write)</strong> so it
        can read the PR diff and post thread comments. Store it as a secret
        pipeline variable named <code>AZURE_DEVOPS_TOKEN</code>. Add your
        inference key (<code>MODEL_API_KEY</code>) the same
        way.
      </p>

      <h2>2. Add the pipeline step</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`trigger: none
pr:
  branches:
    include: ['*']

pool:
  vmImage: ubuntu-latest

steps:
  - script: |
      curl -fsSL https://postil.dev/install.sh | sh
      export PATH="$HOME/.local/bin:$PATH"
      org="$(basename "\${SYSTEM_COLLECTIONURI%/}")"
      postil review --forge azure \\
        --repo "$org/$SYSTEM_TEAMPROJECT/$BUILD_REPOSITORY_NAME" \\
        --pr "$SYSTEM_PULLREQUEST_PULLREQUESTID"
    env:
      AZURE_DEVOPS_TOKEN: $(AZURE_DEVOPS_TOKEN)
      MODEL_API_KEY: $(MODEL_API_KEY)
      POSTIL_API_KEY: $(MODEL_API_KEY)`}</code>
      </pre>
      <p>
        The repository for <code>--repo</code> is{" "}
        <code>organization/project/repository</code>. A gate-failing review
        exits <code>1</code> and fails the step; a clean review exits{" "}
        <code>0</code> and posts nothing; see{" "}
        <Link href="/docs/exit-codes">exit codes</Link>. Mark the pipeline{" "}
        <strong>required</strong> in the branch policy to make the gate
        binding.
      </p>

      <h2>3. Azure DevOps Server</h2>
      <p>
        For self-hosted Azure DevOps Server, point the CLI at your instance
        with <code>AZURE_DEVOPS_API_URL</code>:
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`export AZURE_DEVOPS_TOKEN=...
export MODEL_API_KEY=...
export POSTIL_API_KEY="$MODEL_API_KEY"
export AZURE_DEVOPS_API_URL=https://azuredevops.example.com
postil review --forge azure --repo organization/project/repository --pr 7`}</code>
      </pre>

      <h2>Local review against an Azure DevOps PR</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`export AZURE_DEVOPS_TOKEN=...
export MODEL_API_KEY=...
export POSTIL_API_KEY="$MODEL_API_KEY"
postil review --forge azure --repo organization/project/repository --pr 7`}</code>
      </pre>

      <h2>Parity and limits</h2>
      <ul>
        <li>
          Same gate thresholds, envelope schema, and exit codes as every other
          forge; see the <Link href="/docs/cli">CLI reference</Link> and{" "}
          <Link href="/docs/exit-codes">exit codes</Link>.
        </li>
        <li>
          <code>postil respond</code> (the <code>@postil</code> interactive
          bot) supports <code>--pr</code> only. Azure Boards work items use a
          different API base and version than the pull-request endpoints
          Postil talks to; pointing <code>respond</code> at{" "}
          <code>--issue</code> on Azure DevOps returns an error rather than
          silently doing nothing.
        </li>
        <li>
          The hosted Postil app is GitHub-only; on Azure DevOps you run
          the CLI in your own pipeline.
        </li>
        <li>
          See the <Link href="/docs/forges">forges overview</Link> for
          GitHub, GitLab, and Bitbucket.
        </li>
      </ul>
    </div>
  );
}
