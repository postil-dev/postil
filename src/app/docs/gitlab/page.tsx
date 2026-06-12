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
        variable named <code>GITLAB_TOKEN</code>. Add your inference key
        (for example <code>OPENROUTER_API_KEY</code>) the same way.
      </p>

      <h2>2. Add the CI job</h2>
      <pre>
        <code>{`postil:
  image: debian:bookworm-slim
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  before_script:
    - apt-get update && apt-get install -y curl ca-certificates
    - curl -fsSL https://postil.dev/install.sh | sh
    - export PATH="$HOME/.local/bin:$PATH"
  script:
    - postil review --forge gitlab
        --repo $CI_PROJECT_PATH
        --pr $CI_MERGE_REQUEST_IID
  variables:
    GITLAB_TOKEN: $GITLAB_TOKEN
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
        For GitLab Self-Managed, point the CLI at your instance with the{" "}
        <code>GITLAB_API_URL</code> environment variable:
      </p>
      <pre>
        <code>{`export GITLAB_TOKEN=glpat-...
export GITLAB_API_URL=https://gitlab.example.com/api/v4
postil review --forge gitlab \\
  --repo $CI_PROJECT_PATH --pr $CI_MERGE_REQUEST_IID`}</code>
      </pre>
      <p>
        The token, scopes, and gate semantics are identical to GitLab.com. No
        outbound connection is made to Postil; the review runs entirely inside
        your CI with your inference key.
      </p>

      <h2>Local review against a GitLab MR</h2>
      <p>
        You do not need CI to try it. With <code>GITLAB_TOKEN</code> set
        locally:
      </p>
      <pre>
        <code>{`export GITLAB_TOKEN=glpat-...
postil review --forge gitlab --repo group/project --pr 88
# self-managed:
export GITLAB_API_URL=https://gitlab.example.com/api/v4
postil review --forge gitlab --repo group/project --pr 88`}</code>
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
          The hosted Postil app and the interactive <code>@postil</code> bot are
          GitHub-only today; on GitLab you run the CLI in CI.
        </li>
        <li>
          Bitbucket and Azure DevOps are supported through the same forge
          abstraction (<code>--forge bitbucket</code>,{" "}
          <code>--forge azure</code>). Both are early: shipped and covered by
          tests, but not yet validated against live instances.
        </li>
      </ul>
    </div>
  );
}
