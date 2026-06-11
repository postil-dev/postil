import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "CLI reference",
  description:
    "Postil CLI command reference: review, doctor, plan, and their flags, plus environment variables and exit codes.",
  alternates: { canonical: "/docs/cli" },
};

const COMMANDS = [
  {
    name: "postil review",
    summary: "Review a diff and emit findings, comments, and a gate verdict.",
    flags: [
      ["--staged", "Review staged changes (git index)."],
      ["--base <ref>", "Review the current branch against a base ref."],
      ["--diff <file>", "Review a unified diff read from a file or stdin (-)."],
      ["--pr <n>", "Review a GitHub pull request by number."],
      ["--mr <n>", "Review a GitLab merge request by IID."],
      ["--forge <github|gitlab>", "Select the forge for remote review (default: github)."],
      ["--forge-url <url>", "Base URL for a self-managed forge instance."],
      ["--fail-on <severity>", "Gate threshold: error (default), warn, or never."],
      ["--config <path>", "Path to .postil.yaml (default: repo root)."],
      ["--model <id>", "Override the configured model for this run."],
      ["--output-json", "Print the full review envelope as JSON to stdout."],
      ["--no-comments", "Compute the review but do not post comments to the forge."],
    ],
  },
  {
    name: "postil doctor",
    summary:
      "Preflight check: verify the endpoint, key, model, config, and forge before reviewing.",
    flags: [
      ["--config <path>", "Path to .postil.yaml to validate."],
      ["--json", "Emit machine-readable results."],
    ],
  },
  {
    name: "postil plan",
    summary:
      "Dry-run a config change against stored envelopes. No model calls, no API spend.",
    flags: [
      ["--config <path>", "Candidate config to evaluate."],
      ["--since <date>", "Only consider envelopes after this date."],
      ["--json", "Emit the would-ship / would-suppress breakdown as JSON."],
    ],
  },
] as const;

const ENV = [
  ["OPENROUTER_API_KEY", "Inference key for the default OpenRouter provider."],
  ["ANTHROPIC_API_KEY", "Inference key when the provider is Anthropic."],
  ["OPENAI_API_KEY", "Inference key for Azure OpenAI / OpenAI-compatible endpoints."],
  ["GITHUB_TOKEN", "Token for GitHub remote review and comment posting."],
  ["POSTIL_GITLAB_TOKEN", "Project access token for GitLab remote review."],
] as const;

export default function CliReferencePage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">CLI reference</h1>
      <p className="mt-4 text-lg">
        Postil is one binary, <code>postil</code>. Three commands cover the whole
        workflow: review a diff, verify your setup, and dry-run a config change.
      </p>

      {COMMANDS.map((cmd) => (
        <section key={cmd.name}>
          <h2>
            <code>{cmd.name}</code>
          </h2>
          <p>{cmd.summary}</p>
          <table>
            <thead>
              <tr>
                <th>Flag</th>
                <th>Description</th>
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
        </section>
      ))}

      <h2>Environment variables</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Purpose</th>
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

      <h2>Exit codes</h2>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Meaning</th>
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
      <pre>
        <code>{`# review staged changes locally
postil review --staged

# review a branch against main, fail only on errors
postil review --base main --fail-on error

# review a GitHub PR and print the envelope
postil review --pr 4127 --output-json

# review a GitLab MR on a self-managed instance
postil review --forge gitlab \\
  --forge-url https://gitlab.example.com --mr 88

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
