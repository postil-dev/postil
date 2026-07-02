import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Exit codes",
  description:
    "The postil CLI exit code contract: 0 clean or below the gate threshold, 1 gate-failing findings, 2 operational error. What CI should do with each.",
  alternates: { canonical: "/docs/exit-codes" },
};

export default function ExitCodesPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Exit codes</h1>
      <p className="mt-4 text-lg">
        <code>postil review</code> and <code>postil doctor</code> use three
        exit codes. A CI job that gates on the wrong signal — or catches
        everything as one bucket — either blocks merges it should not or lets
        through ones it should have stopped. This page is the precise
        contract.
      </p>

      <table>
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Meaning</th>
            <th scope="col">What CI should do</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>0</code></td>
            <td>
              Clean review, or findings exist but all are below{" "}
              <code>gate.failOn</code>.
            </td>
            <td>Pass the job. Nothing to act on.</td>
          </tr>
          <tr>
            <td><code>1</code></td>
            <td>
              At least one finding at or above <code>gate.failOn</code>{" "}
              (default <code>error</code>).
            </td>
            <td>
              Fail the job. This is the signal branch protection should
              require — see <Link href="/docs/gate">the gate</Link>.
            </td>
          </tr>
          <tr>
            <td><code>2</code></td>
            <td>
              Operational error: bad arguments, a missing or invalid config,
              no API key, a diff/PR-metadata fetch that failed before a
              review could run, or any other unrecoverable setup problem.
            </td>
            <td>
              Fail the job, but treat it as an infrastructure problem, not a
              code-quality verdict. Check the stderr message (
              <code>postil: error: ...</code>) rather than re-running
              blindly.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>0 vs 1: the gate, not the finding count</h2>
      <p>
        Exit <code>0</code> does not mean zero findings — it means nothing
        crossed the gate threshold. A repo with{" "}
        <code>gate.failOn: error</code> can post several <code>warn</code> and{" "}
        <code>info</code> findings on <code>postil/review</code> and still
        exit <code>0</code>, because <code>postil/gate</code> only cares about{" "}
        <code>error</code>-severity findings by default. Raise the threshold
        with <code>--fail-on</code> or <code>gate.failOn: warn</code> to make
        warnings block too. Preview the effect of a threshold change without
        spending model calls with{" "}
        <Link href="/docs/plan"><code>postil plan</code></Link>.
      </p>

      <h2>1 always means the gate, never a crash</h2>
      <p>
        Exit <code>1</code> is a successful review that found something. The
        model ran, findings were produced and filtered, and at least one
        cleared the gate threshold. This is working as intended — the same
        exit code a linter uses for "found issues," not for "could not run."
      </p>

      <h2>2: what counts as operational</h2>
      <p>
        Exit <code>2</code> covers failures before or around the review
        itself, not failures in what the model said about the diff:
      </p>
      <ul>
        <li>Invalid CLI arguments or an unparseable config file.</li>
        <li>
          Missing required input — no <code>POSTIL_API_KEY</code>/
          <code>OPENROUTER_API_KEY</code>, no <code>--repo</code> or{" "}
          <code>--pr</code> for remote review, no <code>--staged</code>/
          <code>--base</code>/<code>--diff-file</code> for local review.
        </li>
        <li>
          A pre-review forge call that failed outright — fetching PR
          metadata or the diff itself (auth failure, repository not found,
          network error) before any review content existed.
        </li>
      </ul>
      <p>
        <code>main.rs</code> catches every error <code>dispatch()</code>{" "}
        returns, prints it as <code>postil: error: {"<detail>"}</code> to
        stderr, and exits <code>2</code>. Nothing in Postil maps an
        operational error to exit <code>0</code>; a failure to run a review
        is never reported as a pass.
      </p>

      <h2>The error-path advisory nuance</h2>
      <p>
        For remote reviews, a pre-review fetch failure both exits{" "}
        <code>2</code> at the process level <em>and</em> — best effort — posts
        a synthetic error envelope to the forge&apos;s check-runs before the
        process exits, so the PR page reflects the failure even though the
        CLI invocation itself reports an operational error. That check-run
        outcome depends on <code>gate.onError</code>:
      </p>
      <ul>
        <li>
          <code>gate.onError: block</code> (default) — <code>postil/gate</code>{" "}
          completes as failing on the forge, matching the process exit code.
        </li>
        <li>
          <code>gate.onError: advisory</code> — <code>postil/gate</code>{" "}
          completes as passing on the forge (a provider outage should not
          freeze a merge queue), but <code>postil/review</code> still shows{" "}
          <code>neutral</code> with the error, and the CLI process itself
          still exits <code>2</code>. <code>gate.onError</code> only changes
          what the forge check-run reports; it never changes the CLI exit
          code, and it never applies to unusable model output — only to
          provider-class failures (timeouts, outages, unreachable
          endpoints).
        </li>
      </ul>
      <p>
        Once a review actually runs and the model returns output that cannot
        be validated, that is not an operational error — it is a gate-failing
        finding at <code>.postil/model-output:1</code> (exit <code>1</code>),
        because a malicious diff can otherwise induce unusable output through
        prompt injection and must never be rewarded with a silent pass. Fail
        closed applies uniformly regardless of <code>gate.onError</code> for
        that class.
      </p>

      <h2>postil doctor</h2>
      <p>
        <code>postil doctor</code> uses the same two-tier signal:{" "}
        <code>0</code> when every check passes, <code>1</code> when a check
        fails (its report format is documented in{" "}
        <Link href="/docs/self-hosted">self-hosted</Link>). Exit{" "}
        <code>2</code> still applies to operational errors that happen before
        the checks can run — a config file that fails to parse exits{" "}
        <code>2</code> with a <code>postil: error</code> line, exactly like
        any other command.
      </p>

      <h2>Reference: what a CI job should check</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`postil review --repo owner/name --pr "$PR_NUMBER"
case $? in
  0) echo "clean or below gate threshold" ;;
  1) echo "gate-failing findings — block the merge" ; exit 1 ;;
  2) echo "operational error — check postil: error output, not a code review verdict" ; exit 1 ;;
esac`}</code>
      </pre>
      <p>
        Most CI systems already treat a nonzero exit as job failure, so the{" "}
        <code>case</code> above is for jobs that want to log which branch
        fired before failing. See the{" "}
        <Link href="/docs/cli">CLI reference</Link> for every flag and the{" "}
        <Link href="/docs/envelope">envelope schema</Link> for the JSON
        contract that <code>--output-json</code> prints alongside the exit
        code.
      </p>
    </div>
  );
}
