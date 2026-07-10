import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Content policy",
  description: "The opt-in content-policy review dimension: what it checks, how to turn it on, and the built-in baseline.",
  alternates: { canonical: "/docs/content-policy" },
};

export default function ContentPolicyPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Content policy</h1>
      <p className="mt-4 text-lg">
        Off by default. A review dimension is an additional lens the reviewer
        applies to a diff, on top of the core correctness/security review;{" "}
        <strong>content policy</strong> is one such dimension, and it is
        opt-in. It reviews the human-readable prose in a diff (Markdown,
        code comments, docstrings, user-facing or log strings, and the PR
        title/description), never code logic, identifiers, or structured
        data. Violations are reported as <code>contentPolicy</code> findings
        alongside the core reviewer's findings, in the same envelope.
      </p>

      <h2>Turning it on</h2>
      <p>
        Either of these activates content policy for a repo:
      </p>
      <ul>
        <li>
          Set <code>contentPolicy.enabled: true</code> in{" "}
          <Link href="/docs/config"><code>.postil.yaml</code></Link>.
        </li>
        <li>
          Drop a <code>.postil/content-policy.md</code> file in the repo. Its
          presence turns content policy on by itself, the same way{" "}
          <code>.postil/guardrails.md</code> does: no config edit required.
        </li>
      </ul>
      <p>
        An explicit <code>contentPolicy.enabled: false</code> wins over a{" "}
        <code>.postil/content-policy.md</code> file that happens to exist, so
        a repo can keep the file around (for reference, or mid-rollout)
        without it silently turning content policy on.
      </p>

      <h2>Custom policy</h2>
      <p>
        <code>.postil/content-policy.md</code> is plain Markdown, one rule
        per bullet or heading, in the same register as{" "}
        <code>.postil/guardrails.md</code>. Its rules are appended to the
        built-in baseline below, not a replacement for it. Repo-specific
        additions layer on top of the defaults rather than overriding them.
      </p>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`# .postil/content-policy.md
- Do not reference internal codenames in public-facing docs or comments.
- Changelog entries must not use marketing superlatives ("blazing fast").`}</code>
      </pre>

      <h2>The built-in baseline</h2>
      <p>
        Six checks, each with a fixed default severity that reflects how
        confident the model must be before it flags anything:
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Severity</th>
            <th scope="col">What it catches</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Fabricated or contradicted claims</td>
            <td><code>error</code></td>
            <td>
              A changed comment, docstring, or doc line that contradicts the
              code/config/files in the diff or repo, or describes a command,
              flag, path, env var, or behavior that does not exist. A
              plausible description is not flagged merely for being
              unproven: only claims the model can show are false.
            </td>
          </tr>
          <tr>
            <td>Self-contradiction within the change</td>
            <td><code>warn</code></td>
            <td>
              A changed doc or comment asserts something that another file
              changed in the same diff plainly refutes. Both sides of the
              contradiction must be in the diff.
            </td>
          </tr>
          <tr>
            <td>Authoring-process narration and AI-authorship residue</td>
            <td><code>warn</code></td>
            <td>
              Prose that narrates writing the code instead of stating what it
              does, or that reads as assistant/model output leaking into
              committed text. A plain mention of an AI/LLM as a product
              feature is not flagged.
            </td>
          </tr>
          <tr>
            <td>Conversation and transcript leakage</td>
            <td><code>error</code></td>
            <td>
              Pasted chat logs, turn markers, narration of what "the user"
              asked, tool-call/tool-result dumps, or reasoning text leaking
              into committed content.
            </td>
          </tr>
          <tr>
            <td>Stale temporal and TODO residue</td>
            <td><code>info</code></td>
            <td>
              Reference documentation that reads as genuinely stale:
              dangling TODO/FIXME with no owner, "currently"/"for now"
              phrasing describing an already-completed transition. Dated
              changelog entries and explicit roadmap sections are exempt.
            </td>
          </tr>
          <tr>
            <td>House writing style</td>
            <td><code>info</code></td>
            <td>
              Em-dashes, flowery/themed language, or hype filler ("delve",
              "seamless", "leverage" as a verb), flagged only when the same
              pattern repeats three or more times in one file.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Kept conservative and low-noise on purpose: content policy augments
        the core reviewer, it does not turn Postil into a style linter.
        Borderline lines are not flagged.
      </p>

      <h2>In the envelope and check-runs</h2>
      <p>
        Content-policy findings carry{" "}
        <code>kind: &quot;contentPolicy&quot;</code> in the{" "}
        <Link href="/docs/envelope">envelope</Link> and are otherwise
        indistinguishable from other findings: same severity levels, same{" "}
        <code>confidence</code> and suppression rules, same inline comments on{" "}
        <code>postil/review</code>. An <code>error</code>-severity{" "}
        <code>contentPolicy</code> finding gates the PR exactly like any other
        error finding; see <Link href="/docs/gate">the gate</Link>.
      </p>

      <h2>Hosted reviews</h2>
      <p>
        The hosted GitHub App honors <code>.postil.yaml</code>,{" "}
        <code>.postil/guardrails.md</code>, and{" "}
        <code>.postil/content-policy.md</code> from the repository's default
        branch, the same as local and CI reviews resolve them by default.
      </p>
    </div>
  );
}
