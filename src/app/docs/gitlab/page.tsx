import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GitLab",
  description:
    "Run Postil on GitLab.com and self-managed GitLab: CI job setup, project access tokens, merge-request review, and the gate verdict via exit code.",
  alternates: { canonical: "/docs/gitlab" },
};

export default function GitLabDocsPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">GitLab</h1>
      <p className="mt-4 text-lg">
        Postil speaks GitLab through the same review engine it uses for GitHub.
        It posts inline discussion notes on the merge request and reports the
        gate verdict through its exit code, which a CI job fails on.
      </p>

      <h2>1. Create a project access token</h2>
      <p>
        In your project, create a project (or group) access token with the{" "}
        <code>api</code> scope and at least <strong>Developer</strong> role so it
        can read the MR diff and post discussion notes. Store it as a masked CI/CD
        variable named <code>POSTIL_GITLAB_TOKEN</code>. Add your inference key
        (for example <code>OPENROUTER_API_KEY</code>) the same way.
      </p>

      <h2>2. Add the CI job</h2>
      <pre>
        <code>{`postil:
  image: ghcr.io/postil-dev/postil-cli:1
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - postil review --forge gitlab --mr $CI_MERGE_REQUEST_IID
  variables:
    POSTIL_GITLAB_TOKEN: $POSTIL_GITLAB_TOKEN
    OPENROUTER_API_KEY: $OPENROUTER_API_KEY`}</code>
      </pre>
      <p>
        The job runs only on merge-request pipelines. A gate-failing review exits{" "}
        <code>1</code> and fails the job; a clean review exits <code>0</code> and
        posts nothing. To make the gate binding, mark the job{" "}
        <strong>required to merge</strong> in the project&apos;s merge-request
        settings (or require a green pipeline).
      </p>

      <h2>3. Self-managed instances</h2>
      <p>
        For GitLab Self-Managed, point the CLI at your instance with{" "}
        <code>--forge-url</code>:
      </p>
      <pre>
        <code>{`postil review \\
  --forge gitlab \\
  --forge-url https://gitlab.example.com \\
  --mr $CI_MERGE_REQUEST_IID`}</code>
      </pre>
      <p>
        The token, scopes, and gate semantics are identical to GitLab.com. No
        outbound connection is made to Postil; the review runs entirely inside
        your CI with your inference key.
      </p>

      <h2>Local review against a GitLab MR</h2>
      <p>
        You do not need CI to try it. With <code>POSTIL_GITLAB_TOKEN</code> set
        locally:
      </p>
      <pre>
        <code>{`export POSTIL_GITLAB_TOKEN=glpat-...
postil review --forge gitlab --mr 88
# self-managed:
postil review --forge gitlab \\
  --forge-url https://gitlab.example.com --mr 88`}</code>
      </pre>

      <h2>Parity and limits</h2>
      <ul>
        <li>
          Same gate thresholds, envelope schema, and exit codes as GitHub — see
          the <Link href="/docs/cli">CLI reference</Link>.
        </li>
        <li>
          Inline notes are posted on the MR diff; the gate is enforced via the CI
          job result rather than a named external check-run.
        </li>
        <li>
          Bitbucket and Azure DevOps are on the roadmap behind the same forge
          abstraction.
        </li>
      </ul>
    </div>
  );
}
