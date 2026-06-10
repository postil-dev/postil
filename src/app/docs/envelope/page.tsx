import { Code } from "@/components/code";

export const metadata = { title: "Review envelope" };

export default function EnvelopeDocs() {
  return (
    <article className="container-page py-16 max-w-3xl">
      <h1 className="font-serif text-5xl mb-6">Review envelope</h1>
      <p className="text-lg text-[color:var(--color-charcoal-soft)] mb-10 max-w-prose">
        Every consumer of Postil — local CLI, GitHub Action, hosted worker, dashboard —
        reads the same JSON shape. The CLI is the only thing that produces it.
      </p>

      <Code>{`{
  "summary": "<= 240 chars, empty when clean>",
  "findings": [
    {
      "path":     "src/auth.ts",
      "line":     142,
      "severity": "error",
      "kind":     "risk",
      "body":     "Token comparison uses == instead of timing-safe comparator."
    }
  ],
  "usage":      { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "modelUsed":  "deepseek/deepseek-v4-pro",
  "cliVersion": "0.1.0"
}`}</Code>

      <h2 className="font-serif text-3xl mt-10 mb-3">Severity</h2>
      <p className="text-[color:var(--color-charcoal-soft)] mb-3">
        <code>error</code> — will break or compromise something on merge. Sets the check
        conclusion to <code>failure</code> when <code>fail-on</code> is <code>error</code>{" "}
        or lower.
      </p>
      <p className="text-[color:var(--color-charcoal-soft)] mb-3">
        <code>warn</code> — significant risk. Reviewers should evaluate before merging.
      </p>
      <p className="text-[color:var(--color-charcoal-soft)]">
        <code>info</code> — worth knowing. Does not block merge.
      </p>

      <h2 className="font-serif text-3xl mt-10 mb-3">Kind</h2>
      <ul className="space-y-2 text-[color:var(--color-charcoal-soft)]">
        <li><code>risk</code> — concrete merge-breaking risk (bug, regression, security, race).</li>
        <li><code>humanEscalation</code> — the decision belongs to an accountable human.</li>
        <li><code>guardrail</code> — recurring class of issue worth a durable lint/test/policy.</li>
        <li><code>uncertainty</code> — material ambiguity the reviewer cannot resolve from the diff alone.</li>
      </ul>

      <h2 className="font-serif text-3xl mt-10 mb-3">Grounding</h2>
      <p className="text-[color:var(--color-charcoal-soft)]">
        Every <code>path</code> must appear in the diff. Every <code>line</code> must be
        a line touched by the diff. Findings that cite phantom paths are filtered out
        before posting; findings that cite a close-but-wrong line on the right file are
        snapped to the nearest touched line if within 50 lines, dropped otherwise.
      </p>
    </article>
  );
}
