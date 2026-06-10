import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "postil plan",
  description: "Dry-run a review config change against stored envelopes. Terraform-plan semantics for review configuration.",
};

export default function PlanPage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">
        postil plan: config dry-run
      </h1>
      <p className="mt-4 text-lg">
        Review configuration is usually tuned by trial and error against live
        pull requests, for weeks. <code>postil plan</code> replaces that loop
        with a deterministic preview: apply a candidate config to reviews that
        already happened and see exactly what would change.
      </p>

      <h2>How it works</h2>
      <p>
        Every completed review leaves an envelope: the full set of findings
        the model produced, including ones suppressed by your current
        thresholds. <code>postil plan</code> re-applies the candidate config's
        filters — <code>severityThreshold</code>, <code>minConfidence</code>,{" "}
        <code>ignore</code> globs, <code>maxFindings</code>,{" "}
        <code>gate.failOn</code> — to those stored envelopes.
      </p>
      <p>
        No model calls are made. The plan is exact for filtering changes, free
        to run, and instant.
      </p>

      <h2>Usage</h2>
      <pre>
        <code>{`# preview a candidate config against the last 20 stored envelopes
postil plan --config .postil.candidate.yaml --last 20

  plan over 20 reviews (current config -> candidate)

  gate verdicts        2 failing -> 3 failing  (+1)
    src/payments PR#412: warn "unbounded retry loop" now gate-failing
  shipped findings     31 -> 19  (-12)
    11 suppressed by minConfidence 0.6 -> 0.75
    1 suppressed by new ignore glob "generated/**"
  silence rate         55% -> 70%

  no model calls were made.`}</code>
      </pre>

      <h2>What it answers</h2>
      <ul>
        <li>
          "If we raise <code>minConfidence</code> to 0.75, how many of last
          month's comments disappear — and were any of them ones we acted on?"
        </li>
        <li>
          "If the gate also fails on <code>warn</code>, how many merged PRs
          would have been blocked?"
        </li>
        <li>
          "Does ignoring <code>generated/**</code> hide anything that ever
          produced an error-severity finding?"
        </li>
      </ul>

      <h2>Limits, stated plainly</h2>
      <p>
        <code>postil plan</code> re-filters what the model already said. It
        cannot predict findings a different <code>reviewer.focus</code> or
        model would have produced — those change the model call itself. For
        filter and threshold changes (the overwhelming majority of config
        churn) the preview is exact; for model changes it tells you so instead
        of guessing.
      </p>
      <p>
        Envelope format details are in the{" "}
        <Link href="/docs/envelope">envelope schema</Link> reference.
      </p>
    </div>
  );
}
