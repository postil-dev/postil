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

      <h2>Why two checks, not one</h2>
      <p>
        A single check-run cannot do both jobs well. <code>postil/review</code>{" "}
        always completes — even on an operational error — so findings and
        inline comments are visible on every PR, including ones nobody has
        required. <code>postil/gate</code> is the one context you put in
        branch protection: its name is stable, it exists on every reviewed
        commit, and it fails closed when the review itself fails. Collapsing
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
              A finding at or above <code>gate.failOn</code> (default{" "}
              <code>error</code>) exists, or the review could not complete
              (fail closed).
            </td>
          </tr>
          <tr>
            <td><code>postil/review</code></td>
            <td>Advisory findings and inline comments. Never require this one.</td>
            <td>
              Never blocks. Completes <code>neutral</code> on operational
              error, green otherwise.
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
          Do <strong>not</strong> add <code>postil/review</code> — advisory
          findings should inform, not block.
        </li>
        <li>Save the rule.</li>
      </ol>
      <p>
        <code>postil/gate</code> only appears in that search box after it has
        run at least once on the repository — open one PR first, then come
        back and require it.
      </p>
      <p>
        With this in place, a PR with an <code>error</code>-severity finding
        cannot merge until the finding is fixed (the next push re-reviews
        incrementally and resolves it) or the threshold is deliberately
        changed in config — a reviewable, auditable act.
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
        cannot stop a merge. This is the missing primitive the category has:
        teams that wanted "block on critical, ignore nits" previously had to
        accept blocking on everything or nothing.
      </p>

      <h2>Fail-closed semantics</h2>
      <p>
        If the review crashes, times out (10-minute watchdog), or the model
        returns garbage, <code>postil/gate</code> completes as{" "}
        <code>failure</code> with the operational error in the summary. It is
        never left in-progress and never marked neutral. An unreviewed head is
        not a passing head; pushing again or re-requesting the check re-runs
        the review. This is the default, <code>gate.onError: block</code>.
      </p>
      <p>
        Repos that prefer fail-open over a blocked merge queue during a model
        outage can set <code>gate.onError: advisory</code>. This only changes
        behavior on <em>operational</em> errors — a provider outage, an
        exhausted key, model output that fails validation after retry — and
        lets the gate pass in those cases instead of failing closed. It does
        not weaken anything else: findings the model did produce still gate
        normally, and a review that completes successfully with an{" "}
        <code>error</code>-severity finding still fails the gate regardless of
        this setting. Choose <code>advisory</code> deliberately; it trades an
        unreviewed head being treated as passing for never blocking merges on
        Postil's own availability. See{" "}
        <Link href="/docs/config">configuration</Link>.
      </p>

      <h2>Local parity</h2>
      <p>
        The same gate runs locally: <code>postil review --staged</code> exits{" "}
        <code>1</code> exactly when the hosted gate would fail, so a pre-push
        hook (<code>postil hook install</code>) gives you the verdict before
        CI does. Preview threshold changes with{" "}
        <Link href="/docs/plan"><code>postil plan</code></Link>.
      </p>
    </div>
  );
}
