import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Forges",
  description:
    "One review engine, four code hosts: GitHub, GitLab, Bitbucket, and Azure DevOps. Auth, environment variables, and what each forge supports.",
  alternates: { canonical: "/docs/forges" },
};

const FORGES = [
  {
    href: "/docs/forges/github",
    title: "GitHub",
    body: "github.com and GHES. Issues and PRs. The hosted app runs on GitHub.",
  },
  {
    href: "/docs/forges/gitlab",
    title: "GitLab",
    body: "gitlab.com and self-managed. Issues and merge requests, run from your own CI.",
  },
  {
    href: "/docs/forges/bitbucket",
    title: "Bitbucket",
    body: "Cloud and Data Center. Pull requests only, no issue tracker support.",
  },
  {
    href: "/docs/forges/azure",
    title: "Azure DevOps",
    body: "Services and Server. Pull requests only, no work item support.",
  },
] as const;

export default function ForgesIndexPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Forges</h1>
      <p className="mt-4 text-lg">
        Postil is one review engine behind a <code>Forge</code> trait: fetch
        the diff, publish review feedback, complete two check-runs, reply to a
        mention. Four code hosts implement it (GitHub, GitLab, Bitbucket,
        and Azure DevOps), each covering its self-managed or server variant
        through a base-URL environment variable. Pick a forge with{" "}
        <code>--forge</code>; it defaults to <code>github</code> when{" "}
        <code>--repo</code> is set.
      </p>

      <div className="not-prose mt-8 grid gap-5 sm:grid-cols-2">
        {FORGES.map((f) => (
          <Link
            key={f.href}
            href={f.href}
            className="card block p-5 transition-colors hover:border-gate"
          >
            <p className="serif-display text-xl">{f.title}</p>
            <p className="mt-2 text-sm text-ink-soft">{f.body}</p>
          </Link>
        ))}
      </div>

      <h2>Auth and endpoint, per forge</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Forge</th>
            <th scope="col">Token</th>
            <th scope="col">Self-managed / server base URL</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>GitHub</td>
            <td><code>GITHUB_TOKEN</code></td>
            <td><code>GITHUB_API_URL</code> (GitHub Enterprise Server)</td>
          </tr>
          <tr>
            <td>GitLab</td>
            <td><code>GITLAB_TOKEN</code></td>
            <td><code>GITLAB_API_URL</code> (GitLab Self-Managed)</td>
          </tr>
          <tr>
            <td>Bitbucket</td>
            <td>
              <code>BITBUCKET_TOKEN</code> (set{" "}
              <code>BITBUCKET_USER</code> too to use an app password)
            </td>
            <td><code>BITBUCKET_API_URL</code> (Bitbucket Data Center)</td>
          </tr>
          <tr>
            <td>Azure DevOps</td>
            <td><code>AZURE_DEVOPS_TOKEN</code> (a PAT)</td>
            <td><code>AZURE_DEVOPS_API_URL</code> (Azure DevOps Server)</td>
          </tr>
        </tbody>
      </table>
      <p>
        Every forge also needs an inference key:{" "}
        <code>MODEL_API_KEY</code> for any
        OpenAI-compatible endpoint. See the{" "}
        <Link href="/docs/cli">CLI reference</Link> for the full environment
        variable list.
      </p>

      <h2>What each forge supports</h2>
      <p>
        Every forge gets the full <code>postil review</code> engine: the same
        findings, the same gate semantics, the same envelope, the same exit
        codes. What differs is thread coverage for <code>postil respond</code>{" "}
        (the interactive <code>@postil</code> bot) and whether the hosted app
        reaches the forge at all.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Forge</th>
            <th scope="col"><code>postil review</code></th>
            <th scope="col"><code>postil respond</code> threads</th>
            <th scope="col">Hosted app</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>GitHub</td>
            <td>Pull requests</td>
            <td>Issues and pull requests</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td>GitLab</td>
            <td>Merge requests</td>
            <td>Issues and merge requests</td>
            <td>CLI in your own CI only</td>
          </tr>
          <tr>
            <td>Bitbucket</td>
            <td>Pull requests</td>
            <td>Pull requests only</td>
            <td>CLI in your own CI only</td>
          </tr>
          <tr>
            <td>Azure DevOps</td>
            <td>Pull requests</td>
            <td>Pull requests only</td>
            <td>CLI in your own CI only</td>
          </tr>
        </tbody>
      </table>
      <p>
        Stated plainly: GitHub and GitLab cover issues and PRs/MRs for the
        interactive bot; Bitbucket and Azure DevOps cover pull requests only.
        Their issue tracker and work-item APIs use a different shape that
        Postil does not support. The hosted app at{" "}
        <Link href="/">postil.dev</Link> is GitHub-only; every other
        forge runs the same binary in your own CI with your own inference
        key, which is why the CLI ships forge support independent of hosted
        rollout.
      </p>
      <p>
        Gitea and Forgejo are not supported.
      </p>

      <h2>One command per forge</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`# GitHub (default when --repo is set)
postil review --repo owner/name --pr 123

# GitLab (gitlab.com or self-managed)
export MODEL_API_KEY=...
export POSTIL_API_KEY="$MODEL_API_KEY"
export GITLAB_TOKEN=... GITLAB_API_URL=https://gitlab.example.com/api/v4
postil review --forge gitlab --repo group/project --pr 42

# Bitbucket (Cloud, or Data Center via BITBUCKET_API_URL)
export MODEL_API_KEY=...
export POSTIL_API_KEY="$MODEL_API_KEY"
export BITBUCKET_TOKEN=...            # set BITBUCKET_USER too for an app password
postil review --forge bitbucket --repo workspace/repo --pr 7

# Azure DevOps Services (or Server via AZURE_DEVOPS_API_URL)
export MODEL_API_KEY=...
export POSTIL_API_KEY="$MODEL_API_KEY"
export AZURE_DEVOPS_TOKEN=...         # a PAT
postil review --forge azure --repo organization/project/repository --pr 7`}</code>
      </pre>
      <p>
        Same gate thresholds, envelope schema, and exit codes everywhere; see
        the <Link href="/docs/cli">CLI reference</Link> and{" "}
        <Link href="/docs/exit-codes">exit codes</Link>.
      </p>
    </div>
  );
}
