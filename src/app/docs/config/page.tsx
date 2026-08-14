import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Configuration",
  description: "The full .postil.yaml reference, config precedence, and CodeRabbit config translation.",
  alternates: { canonical: "/docs/config" },
};

export default function ConfigPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Configuration</h1>
      <p className="mt-4 text-lg">
        Per-repo configuration lives in <code>.postil.yaml</code> (also{" "}
        <code>.postil.yml</code> or <code>.postil.json</code>). Every knob has
        a working default; an empty file is a valid file.
      </p>
      <p>
        <strong>
          Postil reads an existing <code>.coderabbit.yaml</code> automatically
        </strong>
        , with no setup step: a repo migrating from CodeRabbit gets a sensible
        translation of the overlapping settings on the first run, before
        anyone writes a line of Postil-specific config. This compatibility
        read covers the CodeRabbit settings listed below.
      </p>

      <h2>Precedence</h2>
      <p>
        In the hosted GitHub App, each configuration artifact resolves separately:
        the target repository, the owner account&apos;s installed <code>.github</code>{" "}
        repository, organization form fallback, then built-in defaults. Shared owner
        configuration reads only <code>.postil.yaml</code>,{" "}
        <code>.postil/guardrails.md</code>, and{" "}
        <code>.postil/content-policy.md</code> from one default-branch commit. The App
        never reads an uninstalled public repository without authentication. Authorization
        or identity failures remove the shared snapshot and return no shared policy. A
        transient refresh may use the last successful snapshot only after the current call
        validates installation access and immutable repository identity.
      </p>
      <p>
        Add or create <code>&lt;owner&gt;/.github</code> in the same GitHub App installation
        to use shared configuration. Public source files are public. Private and internal
        source files follow GitHub repository access, but policy text is not a secret:
        review output can reveal its effect.
      </p>
      <p>
        Anyone who can merge to the owner <code>.github</code> repository can change review
        policy for every inheriting repository. Protect its default branch with CODEOWNERS,
        a ruleset, and required review.
      </p>
      <p>From strongest to weakest:</p>
      <ol>
        <li>CLI flags</li>
        <li>Environment variables</li>
        <li><code>.postil.{"{yaml,yml,json}"}</code></li>
        <li><code>.coderabbit.yaml</code> (compatibility read)</li>
        <li>Built-in defaults</li>
      </ol>
      <p>
        Add a <code>.postil.yaml</code> later to use Postil-specific features;
        it wins wherever both define a value. Use{" "}
        <code>postil config</code> to print the resolved configuration with the
        provenance of every value.
      </p>

      <h2>What translates from <code>.coderabbit.yaml</code></h2>
      <p>
        Three settings, mapped directly:
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">CodeRabbit key</th>
            <th scope="col">Maps to</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Path filters</td>
            <td><code>ignore</code></td>
          </tr>
          <tr>
            <td>Review <code>profile</code></td>
            <td><code>minConfidence</code></td>
          </tr>
          <tr>
            <td><code>enabled</code></td>
            <td><code>enabled</code></td>
          </tr>
        </tbody>
      </table>
      <p>
        Everything else in a <code>.coderabbit.yaml</code> (custom
        instructions, tool integrations, path-specific instructions beyond
        simple filters, and any CodeRabbit-only knob not listed above) is not
        read. Configs from Qodo, Macroscope, or other review tools are{" "}
        <strong>not translated at all</strong>; only <code>.coderabbit.yaml</code>{" "}
        gets a compatibility read. This narrow translation surface is not a
        claim of broad config compatibility across the category.
      </p>

      <h2>Full reference</h2>
      <p>
        Hosted inference ignores the entire <code>model</code> block and uses
        Postil&apos;s operator-managed roster. Repository model, fallback, and API
        settings apply only to BYOK organizations, the CLI, and self-hosted
        deployments.
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`# .postil.yaml: every key, with defaults
enabled: true            # disable reviews for this repo entirely

ignore:                  # globs excluded from review
  - "vendor/**"
  - "**/*.lock"
  - "dist/**"

severityThreshold: info  # drop findings below: info | warn | error
minConfidence: 0.6       # drop findings below this confidence
maxFindings: 20          # hard cap per review; excess counted as suppressed

reviewer:
  tone: "direct, specific, no praise, no filler"  # free-form, passed to the model
  focus:                 # steer attention; free-form, passed to the model
    - correctness
    - security

review:
  onClean: skip          # skip = stay silent on clean PRs (default) | comment
  findingPresentation: reviewComments # reviewComments (default) | checkAnnotations (GitHub only)

contentPolicy:
  enabled: true          # built-in prose/content baseline; false opts out

gate:
  failOn: error          # the gate fails at/above this severity
  onError: block         # block (fail closed, default) | advisory
                         # direct CLI publication only

model:
  name: z-ai/glm-5.2
  cascade:               # fallbacks, tried in order on provider errors
    - moonshotai/kimi-k2.7-code
    - deepseek/deepseek-v4-flash
  apiBase: https://openrouter.ai/api/v1
  consensus: 1           # run the first N of [name + cascade], keep only
                         # findings they agree on (must be >= 1)`}</code>
      </pre>

      <h2>Gate behavior on operational errors</h2>
      <p>
        <code>gate.onError</code> controls the gate check produced by direct CLI
        publication when a provider failure prevents a verdict. The default,
        <code>block</code>, fails that gate; <code>advisory</code> leaves it
        neutral. It does not change the CLI&apos;s operational exit code. Hosted
        Postil uses the organization merge-gate setting instead: enforced
        organizations receive a failing <code>postil/gate</code> for a
        no-verdict run, while advisory organizations receive a neutral gate.
        Findings from completed reviews still use <code>gate.failOn</code>.
      </p>

      <h2>Repo guardrails</h2>
      <p>
        Drop repo-specific merge rules in <code>.postil/guardrails.md</code>{" "}
        (plain Markdown, one rule per bullet or heading) and Postil injects
        them into the review prompt. A change that violates one is reported as
        a <code>guardrail</code> finding that quotes the rule it breaks; see
        the <Link href="/docs/envelope">envelope schema</Link>.
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`# .postil/guardrails.md
- Every new API route must enforce org-scoped authorization.
- Database migrations must be reversible.
- No direct writes to the billing tables outside src/billing/.`}</code>
      </pre>

      <h2>Content policy</h2>
      <p>
        On by default, content policy reviews changed human-readable prose
        (comments, docstrings, Markdown, and the PR title/description)
        against the built-in baseline. A <code>.postil/content-policy.md</code>{" "}
        file appends repo-specific rules to that baseline. Set{" "}
        <code>contentPolicy.enabled: false</code> to opt out entirely.
        Violations surface as <code>contentPolicy</code> findings. See{" "}
        <Link href="/docs/content-policy">content policy</Link> for the
        baseline, extensions, and opt-out behavior.
      </p>

      <h2>Environment variables</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Variable</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>MODEL_API_KEY</code></td>
            <td>
              LLM API key; falls back to <code>POSTIL_API_KEY</code>, then{" "}
              <code>OPENROUTER_API_KEY</code>
            </td>
          </tr>
          <tr>
            <td><code>POSTIL_API_BASE</code></td>
            <td>
              OpenAI-compatible or Anthropic API base URL (default{" "}
              <code>https://openrouter.ai/api/v1</code>)
            </td>
          </tr>
          <tr>
            <td><code>POSTIL_API_FORMAT</code></td>
            <td>
              <code>openai-compatible</code> (default) or <code>anthropic</code>
            </td>
          </tr>
          <tr>
            <td><code>POSTIL_ENDPOINT_AUTH_HEADER</code></td>
            <td>Optional private-gateway authentication header; set with its value</td>
          </tr>
          <tr>
            <td><code>POSTIL_ENDPOINT_AUTH_VALUE</code></td>
            <td>Secret value paired with the private-gateway authentication header</td>
          </tr>
          <tr>
            <td><code>REVIEW_MODEL</code></td>
            <td>Model id for BYOK, CLI, and self-hosted use</td>
          </tr>
          <tr>
            <td><code>REVIEW_MODEL_CASCADE</code></td>
            <td>Comma-separated fallback models for BYOK, CLI, and self-hosted use</td>
          </tr>
          <tr>
            <td><code>GITHUB_TOKEN</code></td>
            <td>
              Token for GitHub API access (<code>--forge github</code>;
              required for remote reviews)
            </td>
          </tr>
          <tr>
            <td><code>GITHUB_API_URL</code></td>
            <td>
              GitHub API base URL for GitHub Enterprise Server (default{" "}
              <code>https://api.github.com</code>)
            </td>
          </tr>
          <tr>
            <td><code>GITLAB_TOKEN</code></td>
            <td>Token for GitLab API access (<code>--forge gitlab</code>)</td>
          </tr>
          <tr>
            <td><code>GITLAB_API_URL</code></td>
            <td>
              GitLab API base URL for self-managed instances (default{" "}
              <code>https://gitlab.com/api/v4</code>)
            </td>
          </tr>
          <tr>
            <td><code>BITBUCKET_TOKEN</code></td>
            <td>
              Token for Bitbucket API access (<code>--forge bitbucket</code>);
              sent as a bearer token, or as the password for basic auth when{" "}
              <code>BITBUCKET_USER</code> is also set
            </td>
          </tr>
          <tr>
            <td><code>BITBUCKET_USER</code></td>
            <td>
              Username for Bitbucket app-password (basic) auth; when set,{" "}
              <code>BITBUCKET_TOKEN</code> is used as the password
            </td>
          </tr>
          <tr>
            <td><code>BITBUCKET_API_URL</code></td>
            <td>
              Bitbucket API base URL (default{" "}
              <code>https://api.bitbucket.org/2.0</code>)
            </td>
          </tr>
          <tr>
            <td><code>AZURE_DEVOPS_TOKEN</code></td>
            <td>
              Personal access token for Azure DevOps (
              <code>--forge azure</code>)
            </td>
          </tr>
          <tr>
            <td><code>AZURE_DEVOPS_API_URL</code></td>
            <td>
              Azure DevOps API base URL (default{" "}
              <code>https://dev.azure.com</code>)
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Each remote forge reads its own token plus an optional base-URL
        override for self-managed or enterprise instances. Only the variables
        for the forge you target are required. Unlike some self-hosted
        reviewers, Postil never silently substitutes a different provider: if
        the configured model cannot be reached with the configured credentials,
        the review fails with exit code <code>2</code> and a precise error.{" "}
        <code>postil doctor</code> runs the same checks standalone.
      </p>

      <h2>Trying changes safely</h2>
      <p>
        Do not tune thresholds against live PRs. Run{" "}
        <Link href="/docs/plan"><code>postil plan</code></Link> with the
        candidate file to see what it would have changed on your recent
        reviews.
      </p>
    </div>
  );
}
