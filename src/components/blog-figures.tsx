import Link from "next/link";
import { BENCH, benchModel } from "@/components/bench-table";
import caseEvidence from "../../public/bench/screening-0.8.26-case-evidence.json";
import cleanBank from "../../public/bench/screening-0.9.7-clean-bank-v2.json";

export function CleanReviewChart({ experiment = "historical" }: { experiment?: "historical" | "expanded" }) {
  const expanded = experiment === "expanded";
  const models = expanded
    ? cleanBank.models.map(model => ({
      id: model.model,
      silent: model.total.finalReviewsSilent,
      total: model.total.attempted,
      withFindings: model.total.casesWithFinalFindings,
      unavailable: model.total.unavailable,
      provider: model.providerContract.upstreamProviderRoute,
    }))
    : ["openai/gpt-5.6-luna", "z-ai/glm-5.2"].map(id => {
      const model = benchModel(id);
      const cases = caseEvidence.runs.find(run => run.model === id)!.results.filter(result => result.type === "clean");
      return {
        id,
        silent: model.cleanCasesSilent!,
        total: model.cleanCases!,
        withFindings: cases.filter(result => result.scored && !result.silent).length,
        unavailable: cases.filter(result => !result.scored).length,
        provider: "unconstrained routing",
      };
    });

  return (
    <figure className="my-8 rounded-card border border-charcoal/15 p-5">
      <h3 className="!mt-0">Clean cases with a silent final Postil review</h3>
      <ul className="!m-0 !list-none !p-0 space-y-5">
        {models.map(model => (
          <li key={model.id} className="!p-0">
            <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-sm">
              <span>{model.id === "openai/gpt-5.6-luna" ? "GPT-5.6 Luna" : "GLM-5.2"}</span>
              <span>{model.silent} / {model.total}</span>
            </div>
            <div className="h-3 overflow-hidden rounded-sm bg-charcoal/10" aria-hidden="true">
              <div className="h-full bg-rust" style={{ width: `${100 * model.silent / model.total}%` }} />
            </div>
            <p className="!mb-0 !mt-1 text-xs text-charcoal/70">
              Final reviews with findings: {model.withFindings}. Unavailable: {model.unavailable}. Route: {model.provider}.
            </p>
          </li>
        ))}
      </ul>
      <figcaption className="mt-4 text-sm text-charcoal/70">
        {expanded
          ? <>One run per model on the separate <a href="/bench/screening-0.9.7-clean-bank-v2.json">25-case clean bank</a>, using the same inputs for both models.</>
          : <>The {BENCH.cleanCases} clean cases from the <Link href="/bench">historical 70-case screening report</Link>.</>}
        {" "}Bars start at zero and span the full clean-case count. Any retained finding counts against
        silence, even a nonblocking warning. Suppressed candidates are separate from final findings.
        Unavailable means no usable review result and does not count as silence.
      </figcaption>
    </figure>
  );
}
