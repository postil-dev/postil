import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "The gate",
  description: "postil/gate semantics, fail-on thresholds, and requiring the gate in GitHub branch protection.",
  alternates: { canonical: "/docs/gate" },
};

export default function GatePage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">
        The gate and branch protection
      </h1>
      <p className="mt-4 text-lg">
        Postil completes two check-runs on every reviewed PR. They have
        different jobs and must never be conflated.
      </p>

      <h2>Why the gate is a separate check</h2>
      <p>
        A single check-run cannot do both jobs well. <code>postil/review</code>{" "}
        reports whether a reviewer verdict exists and carries findings when it
        does. <code>postil/gate</code> is the one context you put in
        branch protection: its name is stable, it exists on every reviewed
        commit, and it applies the configured enforcement policy when review
        execution fails. Collapsing
        them into one check forces a choice between hiding findings on PRs
        that do not require the check, or giving the required check an
        unstable name (or unstable pass/fail rules) as its job changes. Two
        checks with fixed, separate jobs avoids both.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Job</th>
            <th scope="col">Fails when</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>postil/gate</code></td>
            <td>The blocking verdict. Require this one in branch protection.</td>
            <td>
              With merge enforcement enabled, a finding at or above{" "}
              <code>gate.failOn</code> (default <code>error</code>) exists or
              the review could not produce a verdict. Advisory organizations
              receive a neutral gate.
            </td>
          </tr>
          <tr>
            <td><code>postil/review</code></td>
            <td>Advisory findings and pull-request review comments. Never require this one.</td>
            <td>
              Never blocks. Completes <code>neutral</code> when no published
              reviewer verdict exists and green after a verdict is published.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Requiring the gate</h2>
      <p>
        GitHub's own reference for this feature is the{" "}
        <a
          href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches"
          rel="noopener"
        >
          protected branches
        </a>{" "}
        guide and the{" "}
        <a
          href="https://docs.github.com/en/rest/branches/branch-protection"
          rel="noopener"
        >
          required status checks API
        </a>. To require the gate on a specific repository:
      </p>
      <ol>
        <li>
          Go to <code>github.com/&lt;org&gt;/&lt;repo&gt;/settings/branches</code>{" "}
          (Repository <strong>Settings → Branches</strong>).
        </li>
        <li>
          Add or edit a branch protection rule for your default branch (or the
          equivalent ruleset).
        </li>
        <li>
          Enable <strong>Require status checks to pass before merging</strong>.
        </li>
        <li>
          Search for and add <code>postil/gate</code> to the required checks.
          Do <strong>not</strong> add <code>postil/review</code>: advisory
          findings should inform, not block.
        </li>
        <li>Save the rule.</li>
      </ol>
      <p>
        <code>postil/gate</code> only appears in that search box after it has
        run at least once on the repository. Open one PR first, then come
        back and require it.
      </p>
      <p>
        Bind the required check to the <strong>Postil GitHub App</strong>, not
        any source. Rulesets record that source as an integration id, and classic
        branch protection records it as an App id. Postil verifies either exact
        binding under <strong>Settings → Installation health</strong>. Missing or
        unreadable source identity is shown as <strong>unverified</strong>.
      </p>
      <p>
        For merges covered by this rule, a PR with an <code>error</code>-severity
        finding cannot merge until the finding is fixed (the next push
        re-reviews incrementally and resolves it) or the threshold is
        deliberately changed in config, a reviewable, auditable act. Configured
        bypass actors remain exempt.
      </p>

      <h2>Choosing a threshold</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`# .postil.yaml
gate:
  failOn: error   # default: block only on error-severity findings
  # failOn: warn  # stricter: block on warnings too`}</code>
      </pre>
      <p>
        The default blocks only on <code>error</code>: findings the model is
        confident affect correctness, security, or data integrity. Warnings
        and informational findings stay in the advisory check where they
        cannot stop a merge. Teams can block on critical issues while keeping
        lower-severity notes advisory.
      </p>
      <p>
        <code>humanEscalation</code> findings are also kind-blocking by
        default once their calibrated confidence reaches <code>0.30</code>.
        Weaker escalation signals remain visible in the review but do not
        fail the gate. The pull request is the escalation channel: update the
        change and push again, or have an organization admin approve an eligible
        judgment call with a rationale in the linked Postil run. A finding that
        also blocks by severity requires a change and cannot be approved away.
      </p>

      <h2>Operational failures</h2>
      <p>
        If the review crashes, times out (10-minute watchdog), or the model
        returns unusable output, <code>postil/review</code> completes neutral
        because no reviewer verdict exists. <code>postil/gate</code> completes
        as <code>failure</code> when the organization has enabled merge
        enforcement and as <code>neutral</code> while the merge gate is
        advisory. Neither check remains in progress. Pushing again or
        re-requesting the check re-runs the review.
      </p>
      <p>
        New organizations start with an advisory merge gate. An organization
        admin can enable merge enforcement after adding <code>postil/gate</code>{" "}
        to branch protection. Enforcement applies to both validated blocking
        findings and execution failures that produce no verdict. Repository
        thresholds still determine which completed-review findings block. See{" "}
        <Link href="/docs/config">configuration</Link> for repository policy.
      </p>

      <h2>Local parity</h2>
      <p>
        The same finding threshold runs locally: <code>postil review --staged</code>{" "}
        exits <code>1</code> when a completed review has blocking findings, and
        exits <code>2</code> on an operational failure. A pre-push hook
        (<code>postil hook install</code>) gives you that result before CI.
        Hosted <code>postil/gate</code> additionally applies the organization
        merge-gate setting. Preview threshold changes with{" "}
        <Link href="/docs/plan"><code>postil plan</code></Link>.
      </p>
    </div>
  );
}
