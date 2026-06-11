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

      <h2>Precedence</h2>
      <p>From strongest to weakest:</p>
      <ol>
        <li>CLI flags</li>
        <li>Environment variables</li>
        <li><code>.postil.{"{yaml,yml,json}"}</code></li>
        <li><code>.coderabbit.yaml</code> (compatibility read)</li>
        <li>Built-in defaults</li>
      </ol>
      <p>
        Migrating from CodeRabbit costs nothing: leave the existing
        <code>.coderabbit.yaml</code> in place and Postil maps the overlapping
        settings (ignore
        patterns, severity thresholds, review toggles). Add a{" "}
        <code>.postil.yaml</code> later to use Postil-specific features; it
        wins wherever both define a value. Use{" "}
        <code>postil config</code> to print the resolved configuration with the
        provenance of every value.
      </p>

      <h2>Full reference</h2>
      <pre>
        <code>{`# .postil.yaml — every key, with defaults
enabled: true            # disable reviews for this repo entirely

ignore:                  # globs excluded from review
  - "vendor/**"
  - "**/*.lock"
  - "dist/**"

severityThreshold: info  # drop findings below: info | warn | error
minConfidence: 0.6       # drop findings below this confidence
maxFindings: 20          # hard cap per review; excess counted as suppressed

reviewer:
  tone: terse            # terse | neutral
  focus:                 # steer attention; free-form, passed to the model
    - correctness
    - security

review:
  onClean: skip          # skip = stay silent on clean PRs (default)
  incremental: true      # review only new hunks since the last review

gate:
  failOn: error          # the gate fails at/above this severity

model:
  name: deepseek/deepseek-v4-pro
  cascade:               # fallbacks, tried in order on provider errors
    - qwen/qwen3-coder
  apiBase: https://openrouter.ai/api/v1`}</code>
      </pre>

      <h2>Environment variables</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>POSTIL_API_KEY</code></td>
            <td>
              LLM API key; falls back to <code>OPENROUTER_API_KEY</code>
            </td>
          </tr>
          <tr>
            <td><code>POSTIL_API_BASE</code></td>
            <td>
              OpenAI-compatible base URL (default{" "}
              <code>https://openrouter.ai/api/v1</code>)
            </td>
          </tr>
          <tr>
            <td><code>REVIEW_MODEL</code></td>
            <td>Model id (default <code>deepseek/deepseek-v4-pro</code>)</td>
          </tr>
          <tr>
            <td><code>REVIEW_MODEL_CASCADE</code></td>
            <td>Comma-separated fallback models</td>
          </tr>
          <tr>
            <td><code>GITHUB_TOKEN</code></td>
            <td>Token for forge API access in remote mode</td>
          </tr>
        </tbody>
      </table>
      <p>
        Unlike some self-hosted reviewers, Postil never silently substitutes a
        different provider: if the configured model cannot be reached with the
        configured credentials, the review fails with exit code <code>2</code>{" "}
        and a precise error. <code>postil doctor</code> runs the same checks
        standalone.
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
