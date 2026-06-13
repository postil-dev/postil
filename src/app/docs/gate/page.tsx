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

      <h2>The two checks</h2>
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
            <td>Blocking verdict. Require this one.</td>
            <td>
              A finding at or above <code>gate.failOn</code> (default{" "}
              <code>error</code>) exists, or the review could not complete
              (fail closed).
            </td>
          </tr>
          <tr>
            <td><code>postil/review</code></td>
            <td>Advisory findings and inline comments.</td>
            <td>
              Never blocks. Completes <code>neutral</code> on operational
              error, green otherwise.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Requiring the gate</h2>
      <ol>
        <li>
          Repository <strong>Settings → Branches → Branch protection rules</strong>{" "}
          (or a ruleset) for your default branch.
        </li>
        <li>
          Enable <strong>Require status checks to pass before merging</strong>.
        </li>
        <li>
          Add <code>postil/gate</code> to the required checks. Do{" "}
          <strong>not</strong> add <code>postil/review</code> — advisory
          findings should inform, not block.
        </li>
      </ol>
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
        the review.
      </p>
      <p>
        Repos that prefer fail-open over a blocked merge queue during a model
        outage can set <code>gate.onError: advisory</code>, which fails open on
        provider outages only; the default remains <code>block</code>. See{" "}
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
