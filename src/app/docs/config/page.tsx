import { Code } from "@/components/code";

export const metadata = { title: "Config — .postil.yaml" };

export default function ConfigDocsPage() {
  return (
    <article className="container-page py-16 max-w-3xl prose">
      <h1 className="font-serif text-5xl mb-6">.postil.yaml</h1>
      <p className="text-lg text-[color:var(--color-charcoal-soft)] mb-8 max-w-prose">
        Per-repo policy. Lives in the repo root. Loaded from the PR head SHA so config
        changes ship atomically with the code that depends on them.
      </p>

      <Code>{`enabled: true
ignore:
  - "dist/**"
  - "vendor/**"
severityThreshold: info       # drop findings below this
maxFindings: 25               # cap inline comments
reviewer:
  tone: neutral               # terse | neutral | verbose
  focus: ["security", "migrations"]
review:
  enabled: true
  onClean: skip               # skip | approve  (default skip — silence is a feature)
  autoMerge: false
  requiredChecks:
    - postil/review
    - Lint
    - Typecheck
  autoMergeTimeoutMs: 15000`}</Code>

      <h2 className="font-serif text-3xl mt-10 mb-3">Precedence</h2>
      <ol className="list-decimal pl-6 text-[color:var(--color-charcoal-soft)] space-y-1">
        <li><code>.postil.{`{yaml,yml,json}`}</code> — canonical</li>
        <li><code>.coderabbit.yaml</code> — <code>reviews.path_filters</code> negations become <code>ignore</code></li>
        <li><code>.kodo.yaml</code> — <code>exclude</code> and <code>severity</code> are mapped</li>
        <li>built-in defaults</li>
      </ol>

      <h2 className="font-serif text-3xl mt-10 mb-3">onClean</h2>
      <p className="text-[color:var(--color-charcoal-soft)] mb-3">
        <code>skip</code> (default) — clean PRs complete the check-run with no comment.
        Silence is a feature.
      </p>
      <p className="text-[color:var(--color-charcoal-soft)]">
        <code>approve</code> — post an APPROVE review on a clean PR. Only needed when
        branch protection requires an approving Postil review.
      </p>

      <h2 className="font-serif text-3xl mt-10 mb-3">Fail-closed semantics</h2>
      <p className="text-[color:var(--color-charcoal-soft)] mb-3">
        If the model returns invalid JSON or the provider call fails after every cascade
        attempt, Postil synthesises a single <code>error</code> finding at{" "}
        <code>.postil/model-output:1</code>. That finding bypasses every filter
        (<code>ignore</code>, <code>severityThreshold</code>, <code>maxFindings</code>),
        so a flaky model can never silently approve a PR.
      </p>
    </article>
  );
}
