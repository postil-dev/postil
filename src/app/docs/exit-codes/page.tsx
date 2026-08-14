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
        exit codes. A CI job that gates on the wrong signal (or catches
        everything as one bucket) either blocks merges it should not or lets
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
              require; see <Link href="/docs/gate">the gate</Link>.
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

      <h2>0 vs 1: what the gate threshold means</h2>
      <p>
        Exit <code>0</code> does not mean zero findings: it means nothing
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
        cleared the gate threshold. This is working as intended: the same
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
          Missing required input: no <code>MODEL_API_KEY</code>,{" "}
          <code>POSTIL_API_KEY</code>, or <code>OPENROUTER_API_KEY</code>; no{" "}
          <code>--repo</code> or{" "}
          <code>--pr</code> for remote review, no <code>--staged</code>/
          <code>--base</code>/<code>--diff-file</code> for local review.
        </li>
        <li>
          A pre-review forge call that failed outright: fetching PR
          metadata or the diff itself (auth failure, repository not found,
          network error) before any review content existed.
        </li>
      </ul>
      <p>
        The CLI writes a bounded <code>postil: error: {"<detail>"}</code>{" "}
        diagnostic to stderr and exits <code>2</code>. An operational failure
        is never reported as a clean review.
      </p>

      <h2>Remote publication and hosted runs</h2>
      <p>
        A remote review can publish a no-verdict result before exiting{" "}
        <code>2</code>. That result uses an envelope whose active findings all
        use reserved operational paths. Ordinary findings, mixed envelopes,
        and path lookalikes are not accepted as an operational result.
      </p>
      <ul>
        <li>
          Direct CLI publication always leaves <code>postil/review</code>{" "}
          neutral because no reviewer verdict exists.{" "}
          <code>gate.onError: block</code> makes <code>postil/gate</code> fail;{" "}
          <code>gate.onError: advisory</code> leaves it neutral. The setting
          never changes exit code <code>2</code>.
        </li>
        <li>
          Hosted Postil retains the validated envelope and usage for private
          diagnostics, records the run as failed with no verdict, and leaves{" "}
          <code>postil/review</code> neutral. The organization merge-gate
          setting controls <code>postil/gate</code>: failure when enforcement
          is enabled, neutral while advisory.
        </li>
      </ul>
      <p>
        A validated review with blocking findings exits <code>1</code>. A model
        or tooling failure that prevents a reviewer verdict exits <code>2</code>{" "}
        and remains distinct from a completed review whose publication to the
        forge is incomplete.
      </p>

      <h2>postil doctor</h2>
      <p>
        <code>postil doctor</code> uses the same two-tier signal:{" "}
        <code>0</code> when every check passes, <code>1</code> when a check
        fails (its report format is documented in{" "}
        <Link href="/docs/self-hosted">self-hosted</Link>). Exit{" "}
        <code>2</code> still applies to operational errors that happen before
        the checks can run: a config file that fails to parse exits{" "}
        <code>2</code> with a <code>postil: error</code> line, exactly like
        any other command.
      </p>

      <h2>Reference: what a CI job should check</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`postil review --repo owner/name --pr "$PR_NUMBER"
case $? in
  0) echo "clean or below gate threshold" ;;
  1) echo "gate-failing findings: block the merge" ; exit 1 ;;
  2) echo "operational error: check postil: error output, not a code review verdict" ; exit 1 ;;
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
