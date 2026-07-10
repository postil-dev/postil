import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Envelope schema",
  description: "The frozen JSON contract the postil CLI emits with --output-json, stored verbatim by the control plane.",
  alternates: { canonical: "/docs/envelope" },
};

export default function EnvelopePage() {
  return (
    <div className="prose-postil">
      <h1 className="serif-display text-4xl text-charcoal">Envelope schema</h1>
      <p className="mt-4 text-lg">
        The envelope is the contract between the CLI and everything else: the
        hosted worker, the Action, your own tooling. It is versioned and
        frozen; the control plane stores it verbatim.
      </p>

      <h2>Why the envelope exists alongside SARIF</h2>
      <p>
        The envelope is the single JSON object <code>postil review</code>{" "}
        emits: findings and the gate verdict, counts, confidence
        distribution, token usage, and provenance (base/head/since SHAs,
        model used) all travel together as one versioned unit. Consumers
        (the hosted worker, the dashboard, <code>postil plan</code>) read one
        object and get the whole picture of a review, not just its findings.
      </p>
      <p>
        Postil also emits SARIF 2.1.0 (<code>--sarif &lt;path&gt;</code>) for
        interop with code-scanning viewers that expect it: GitHub code
        scanning, GitLab SAST, and other SARIF-aware tooling. SARIF is a
        results format: it has no structured gate concept (Postil tucks the
        verdict into a SARIF properties bag, but that is a nonstandard
        extension no consumer can rely on), no confidence buckets, no token
        usage. It answers "what did the reviewer find," not "did this PR
        pass." That gap is why the envelope exists as its own format rather
        than Postil standardizing on SARIF alone.
      </p>
      <p>
        The schema below is <strong>version 1, frozen</strong>. Changes that
        do not break existing consumers (new optional fields) ship in place
        under <code>version: 1</code>; consumers should already tolerate
        unknown fields. Any breaking change ships as a new{" "}
        <code>version: 2</code> alongside version 1, never in place of it. See
        stability, below.
      </p>

      <h2>Schema (version 1)</h2>
      <pre tabIndex={0} aria-label="Code sample">
        <code>{`{
  "version": 1,
  "summary": "1-3 sentence merge-relevant summary, empty string when silent",
  "silent": true,
  "findings": [
    { "path": "src/x.ts", "line": 42, "endLine": 45,
      "severity": "info|warn|error",
      "kind": "risk|humanEscalation|guardrail|uncertainty|contentPolicy",
      "confidence": 0.85, "title": "short", "body": "markdown" }
  ],
  "resolved": [ /* same shape as findings; no longer apply as of this head */ ],
  "counts": { "info": 0, "warn": 0, "error": 0, "suppressed": 0, "ungrounded": 0 },
  "confidenceBuckets": [0, 0, 0, 0, 0],
  "gate": { "failOn": "error", "failing": false },
  "modelUsed": "deepseek/deepseek-v4-pro",
  "usage": { "promptTokens": 0, "completionTokens": 0 },
  "durationMs": 0,
  "baseSha": "...", "headSha": "...", "sinceSha": null
}`}</code>
      </pre>

      <h2>Field notes</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>silent</code></td>
            <td>
              True when the review produced no shippable finding. The summary
              is the empty string and no comment is posted anywhere.
            </td>
          </tr>
          <tr>
            <td><code>findings[].kind</code></td>
            <td>
              <code>risk</code> (a concrete defect or hazard),{" "}
              <code>humanEscalation</code> (a consequential decision that needs
              an accountable human), <code>guardrail</code> (the change violates
              a rule stated in <code>.postil/guardrails.md</code>; the finding
              quotes the rule it breaks), <code>uncertainty</code> (the
              model flags its own doubt), <code>contentPolicy</code> (default-on
              review of prose in the diff; see{" "}
              <Link href="/docs/content-policy">content policy</Link>).
            </td>
          </tr>
          <tr>
            <td><code>findings[].confidence</code></td>
            <td>
              0 to 1. Findings below <code>minConfidence</code> are suppressed
              and counted in <code>counts.suppressed</code>.
            </td>
          </tr>
          <tr>
            <td><code>resolved</code></td>
            <td>
              Only populated on an incremental review (<code>--since-sha</code>{" "}
              with a <code>--baseline</code> envelope from the previous review
              of the same PR head lineage): findings from that baseline which
              no longer apply at the new head. This is a diff against the
              prior envelope, not conversation memory. Postil does not carry
              chat history or retain state between PRs. Powers "N resolved, M
              open" on incremental re-review.
            </td>
          </tr>
          <tr>
            <td><code>confidenceBuckets</code></td>
            <td>
              Five counts over [0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0].
              Aggregated across reviews, this is the dashboard's confidence
              distribution.
            </td>
          </tr>
          <tr>
            <td><code>gate</code></td>
            <td>
              The configured fail-on severity and whether this review fails the
              gate. Mirrors the exit code: <code>failing: true</code> means
              exit <code>1</code>.
            </td>
          </tr>
          <tr>
            <td><code>counts.ungrounded</code></td>
            <td>
              Findings the model reported that did not cite a changed line and
              were dropped. A nonzero value is a model-quality signal; a run
              where every finding was ungrounded fails closed. Optional within
              v1 (absent means 0).
            </td>
          </tr>
          <tr>
            <td><code>durationMs</code></td>
            <td>
              Wall-clock duration of the review engine run in milliseconds.
              Optional within v1 (absent means 0 from older CLIs).
            </td>
          </tr>
          <tr>
            <td><code>sinceSha</code></td>
            <td>
              The previously reviewed head when this was an incremental
              review; <code>null</code> on a full review.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Grounding guarantee</h2>
      <p>
        Every finding must cite a (path, line) present in the reviewed diff.
        Ungrounded model output is dropped; an entirely invalid response
        becomes a synthetic <code>error</code> finding at{" "}
        <code>.postil/model-output:1</code> after one JSON-repair retry, and
        the gate fails. There is no code path in which malformed model output
        produces a passing review.
      </p>

      <h2>Stability</h2>
      <p>
        Consumers should accept unknown additional fields and reject unknown{" "}
        <code>version</code> values. Any breaking change ships as{" "}
        <code>version: 2</code> alongside, never in place.
      </p>
    </div>
  );
}
