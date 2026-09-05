import Link from "next/link";
import { BENCH, benchModel } from "@/components/bench-table";

export function CleanReviewChart() {
  const models = [
    "mistralai/mistral-small-3.2-24b-instruct",
    "google/gemma-3-27b-it",
    "qwen/qwen3-32b",
    "openai/gpt-5.6-luna",
  ].map(benchModel);

  return (
    <figure className="my-8 rounded-card border border-charcoal/15 p-5">
      <h3 className="!mt-0">Clean fixtures reviewed without a finding</h3>
      <ul className="!m-0 !list-none !p-0 space-y-5">
        {models.map((model) => (
          <li key={model.id} className="!p-0">
            <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-sm">
              <span className="break-all font-mono">{model.id}</span>
              <span>{model.cleanCasesSilent} / {model.cleanCases}</span>
            </div>
            <div className="h-3 overflow-hidden rounded-sm bg-charcoal/10" aria-hidden="true">
              <div className="h-full bg-rust" style={{ width: `${100 * (model.cleanCasesSilent ?? 0) / (model.cleanCases || 1)}%` }} />
            </div>
            {model.unscoredCases > 0 && <p className="!mb-0 !mt-1 text-xs text-charcoal/70">{model.unscoredCases} unscored cases across the full corpus.</p>}
          </li>
        ))}
      </ul>
      <figcaption className="mt-4 text-sm text-charcoal/70">
        Selected models from the <Link href="/bench">screening report</Link>.
        Each bar starts at zero and spans {BENCH.cleanCases} clean fixtures.
        A finding on a clean fixture counts against silence, regardless of whether it blocks the gate.
      </figcaption>
    </figure>
  );
}

export function EvidenceTrail() {
  const steps = [
    ["Reviewed code", "Open the reviewed revision. Locate the cited line and compare it with the displayed diff excerpt."],
    ["Finding", "Read the stated failure and check whether the cited code supports it."],
    ["Gate result", "Match the verdict to that same commit and the configured blocking rules."],
  ];
  return (
    <figure className="my-8 rounded-card border border-charcoal/15 p-5">
      <ol className="!m-0 !list-none !p-0">
        {steps.map(([title, body], index) => (
          <li key={title} className="!p-0">
            {index > 0 && <div aria-hidden="true" className="py-2 text-center text-xl text-rust">↓</div>}
            <div className="border-l-2 border-rust bg-charcoal/5 px-4 py-3">
              <strong>{title}</strong>
              <p className="!my-1 text-sm">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <figcaption className="mt-4 text-sm text-charcoal/70">
        Follow an example on the <Link href="/evidence">evidence page</Link> through each step.
        A verdict on a different commit does not verify the reviewed change.
      </figcaption>
    </figure>
  );
}

export function GateOutcomes() {
  return (
    <figure className="my-8 rounded-card border border-charcoal/15 p-5">
      <h3 className="!mt-0">One review, separate outputs</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="border-t-2 border-charcoal/40 bg-charcoal/5 p-4">
          <code>postil/review</code>
          <p className="!my-2 text-sm">Findings and inline comments for the reviewer.</p>
          <span className="text-sm font-semibold">Advisory check</span>
        </div>
        <div className="border-t-2 border-rust bg-rust/5 p-4">
          <code>postil/gate</code>
          <p className="!my-2 text-sm">The enforcement result under the repository&apos;s gate rules.</p>
          <span className="text-sm font-semibold">Required status check</span>
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
        <dt>No blocking findings</dt><dd className="font-semibold">Pass</dd>
        <dt>Blocking finding</dt><dd className="font-semibold text-rust">Fail</dd>
        <dt>Review cannot complete</dt><dd className="font-semibold text-rust">Fail by default</dd>
        <dt>Gating disabled, or unavailable under advisory policy</dt><dd className="font-semibold">Neutral</dd>
      </dl>
      <figcaption className="mt-4 text-sm text-charcoal/70">
        Require <code>postil/gate</code> in branch protection. Warnings can remain advisory;
        severity thresholds and blocking finding kinds determine the verdict. GitHub accepts neutral required checks.
      </figcaption>
    </figure>
  );
}

export function BenchmarkCorpusChart() {
  const total = BENCH.defectCases + BENCH.cleanCases;
  return (
    <figure className="my-8 rounded-card border border-charcoal/15 p-5">
      <h3 className="!mt-0">What the Postil screening report tests</h3>
      <div className="flex h-8 overflow-hidden rounded-sm" aria-hidden="true">
        <div className="bg-rust" style={{ width: `${100 * BENCH.defectCases / total}%` }} />
        <div className="bg-charcoal" style={{ width: `${100 * BENCH.cleanCases / total}%` }} />
      </div>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <div><dt className="font-semibold">{BENCH.defectCases} defect fixtures</dt><dd className="!ml-0 text-sm">Does a finding overlap the seeded region?</dd></div>
        <div><dt className="font-semibold">{BENCH.cleanCases} clean fixtures</dt><dd className="!ml-0 text-sm">Does the reviewer avoid an unsupported finding?</dd></div>
      </dl>
      <figcaption className="mt-4 text-sm text-charcoal/70">
        {total} fixtures in the <Link href="/bench">published screening report</Link>.
        Both groups contribute to gate correctness. These proportions describe this test corpus, not the frequency of defects in real pull requests.
      </figcaption>
    </figure>
  );
}
