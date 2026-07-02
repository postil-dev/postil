import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "CLI reference",
  description:
    "Postil CLI command reference: review, respond, plan, config, init, doctor, and hook, with flags, environment variables, and exit codes.",
  alternates: { canonical: "/docs/cli" },
};

const COMMANDS = [
  {
    name: "postil review",
    summary:
      "Review a diff — a PR/MR on a forge, or local changes — and emit findings, comments, and a gate verdict.",
    flags: [
      ["--staged", "Review staged changes (git diff --cached)."],
      ["--base <ref>", "Review changes since a base ref (git diff base...HEAD)."],
      ["--diff-file <path>", "Review a unified diff from a file."],
      [
        "--forge <forge>",
        "Code host for remote review: github, gitlab, bitbucket, azure, or local. Inferred as github when --repo is set.",
      ],
      [
        "--repo <repo>",
        "Repository as owner/name (GitHub) or group/project (GitLab).",
      ],
      ["--pr <n>", "Pull/merge request number (also used for GitLab MRs)."],
      ["--sha <sha>", "Head SHA to report checks against (defaults to the PR head)."],
      [
        "--since-sha <sha>",
        "Incremental review: only commits since this SHA.",
      ],
      [
        "--baseline <path>",
        "Previous review envelope for finding reconciliation.",
      ],
      [
        "--fail-on <severity>",
        "Exit 1 at/above this severity: info, warn, error, or never. Overrides gate.failOn.",
      ],
      ["--config <path>", "Explicit config file (bypasses discovery)."],
      [
        "--model <id>",
        "Model override (else REVIEW_MODEL, else config, else default).",
      ],
      ["--output-json", "Print the envelope JSON on stdout (machine consumers)."],
      [
        "--sarif <path>",
        "Write SARIF 2.1.0 to this path for code-scanning ingestion.",
      ],
      [
        "--no-post",
        "Do not post comments or checks to the forge; report locally only.",
      ],
    ],
  },
  {
    name: "postil respond",
    summary:
      "Reply to an @postil mention on a pull request or issue (the interactive bot). GitHub and GitLab cover issues and PRs/MRs; Bitbucket and Azure DevOps cover pull requests only. Review-and-answer only: it never opens PRs or pushes commits.",
    flags: [
      [
        "--forge <forge>",
        "Code host: github, gitlab, bitbucket, or azure (default github). GitHub and GitLab accept --pr or --issue; Bitbucket and Azure DevOps accept --pr only.",
      ],
      ["--repo <repo>", "Repository as owner/name."],
      ["--pr <n>", "Pull request number the mention is on."],
      ["--issue <n>", "Issue number the mention is on."],
      [
        "--comment <text>",
        "The maintainer's message text. Falls back to the POSTIL_COMMENT environment variable; prefer that in automation.",
      ],
      ["--config <path>", "Explicit config file (bypasses discovery)."],
      ["--model <id>", "Model override for this reply."],
      ["--no-post", "Print the reply instead of posting it."],
    ],
  },
  {
    name: "postil plan",
    summary:
      "Replay stored envelopes under a candidate config: what would change? No model calls, no API spend.",
    flags: [
      [
        "--envelopes <dir>",
        "Directory of envelope JSON files from previous reviews. Required.",
      ],
      [
        "--config <path>",
        "Candidate config file to evaluate (defaults to discovery).",
      ],
    ],
  },
  {
    name: "postil config",
    summary:
      "Print the resolved configuration and where each value came from (flag, environment, file, or default).",
    flags: [],
  },
  {
    name: "postil init",
    summary: "Write a starter .postil.yaml.",
    flags: [["--force", "Overwrite an existing .postil.yaml."]],
  },
  {
    name: "postil doctor",
    summary:
      "Validate endpoint, key, model, and repo setup with actionable errors. Run it before your first review.",
    flags: [["--config <path>", "Explicit config file to validate."]],
  },
  {
    name: "postil hook",
    summary:
      "Manage git hooks. postil hook install adds a pre-push hook that reviews outgoing commits.",
    flags: [
      ["install --force", "Overwrite an existing pre-push hook on install."],
    ],
  },
] as const;

const ENV = [
  [
    "POSTIL_API_KEY",
    "LLM API key for any OpenAI-compatible endpoint; falls back to OPENROUTER_API_KEY.",
  ],
  [
    "OPENROUTER_API_KEY",
    "Inference key for the default OpenRouter provider.",
  ],
  [
    "POSTIL_API_BASE",
    "OpenAI-compatible base URL (default https://openrouter.ai/api/v1).",
  ],
  ["REVIEW_MODEL", "Model id override."],
  ["REVIEW_MODEL_CASCADE", "Comma-separated fallback models."],
  ["GITHUB_TOKEN", "Token for GitHub remote review and comment posting."],
  ["GITHUB_API_URL", "Base URL for GitHub Enterprise Server."],
  ["GITLAB_TOKEN", "Project or group access token for GitLab remote review."],
  ["GITLAB_API_URL", "Base URL for self-managed GitLab (e.g. https://gitlab.example.com/api/v4)."],
  ["BITBUCKET_TOKEN", "Token for Bitbucket; set BITBUCKET_USER too to use an app password."],
  ["BITBUCKET_API_URL", "Base URL for Bitbucket Data Center."],
  ["AZURE_DEVOPS_TOKEN", "Azure DevOps personal access token."],
  ["AZURE_DEVOPS_API_URL", "Base URL for Azure DevOps Server."],
] as const;

export default function CliReferencePage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">CLI reference</h1>
      <p className="mt-4 text-lg">
        Postil is one binary, <code>postil</code>. Seven commands cover the
        whole workflow: review a diff, reply to a mention, dry-run a config
        change, inspect the resolved config, scaffold one, verify your setup,
        and install the pre-push hook.
      </p>
      <p>
        Remote review supports GitHub, GitLab, Bitbucket, and Azure DevOps via{" "}
        <code>--forge</code>. Bitbucket and Azure DevOps support is best effort:
        shipped, tested, and configured through the documented token and base URL
        variables.
      </p>

      {COMMANDS.map((cmd) => (
        <section key={cmd.name}>
          <h2>
            <code>{cmd.name}</code>
          </h2>
          <p>{cmd.summary}</p>
          {cmd.flags.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th scope="col">Flag</th>
                  <th scope="col">Description</th>
                </tr>
              </thead>
              <tbody>
                {cmd.flags.map(([flag, desc]) => (
                  <tr key={flag}>
                    <td>
                      <code>{flag}</code>
                    </td>
                    <td>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      <h2>Environment variables</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Variable</th>
            <th scope="col">Purpose</th>
          </tr>
        </thead>
        <tbody>
          {ENV.map(([name, desc]) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Postil talks to any OpenAI-compatible endpoint through{" "}
        <code>POSTIL_API_BASE</code>; there are no provider-specific key
        variables beyond <code>POSTIL_API_KEY</code> /{" "}
        <code>OPENROUTER_API_KEY</code>.
      </p>

      <h2>Exit codes</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>0</code>
            </td>
            <td>Clean, or all findings below the gate threshold.</td>
          </tr>
          <tr>
            <td>
              <code>1</code>
            </td>
            <td>Gate-failing findings at or above the threshold.</td>
          </tr>
          <tr>
            <td>
              <code>2</code>
            </td>
            <td>Operational error. Never reported as a pass.</td>
          </tr>
        </tbody>
      </table>

      <h2>Examples</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`# review staged changes locally
postil review --staged

# review a branch against main, fail only on errors
postil review --base main --fail-on error

# review a GitHub PR and print the envelope
postil review --repo owner/name --pr 4127 --output-json

# review a GitLab MR on a self-managed instance
export GITLAB_TOKEN=glpat-...
export GITLAB_API_URL=https://gitlab.example.com/api/v4
postil review --forge gitlab --repo group/project --pr 88

# write SARIF for code-scanning ingestion
postil review --repo owner/name --pr 4127 --sarif postil.sarif

# incremental re-review: only commits since the last reviewed head
postil review --repo owner/name --pr 4127 \\
  --since-sha <last-reviewed-head> --baseline previous-envelope.json

# reply to an @postil mention without posting (dry run)
postil respond --repo owner/name --pr 123 \\
  --comment "@postil is this safe?" --no-post

# dry-run a candidate config against stored envelopes
postil plan --envelopes .cache/envelopes --config .postil.candidate.yaml

# verify setup before the first review
postil doctor`}</code>
      </pre>

      <p>
        See the <Link href="/docs/quickstart">quickstart</Link> for first-run
        setup and <Link href="/docs/config">configuration</Link> for the full{" "}
        <code>.postil.yaml</code> reference.
      </p>
    </div>
  );
}
