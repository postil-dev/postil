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
      suppressed: model.total.suppressedFindings,
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
        suppressed: null,
        unavailable: cases.filter(result => !result.scored).length,
        provider: "unconstrained routing",
      };
    });

  return (
    <figure className="my-8">
      <table className="text-sm">
        <caption>Clean cases with a silent final Postil review</caption>
        <thead><tr><th scope="col">Result</th>{models.map(model => <th key={model.id} scope="col">{model.id === "openai/gpt-5.6-luna" ? "GPT-5.6 Luna" : "GLM-5.2"}</th>)}</tr></thead>
        <tbody>
          <tr><th scope="row">Silent final reviews</th>{models.map(model => <td key={model.id}>{model.silent} / {model.total}</td>)}</tr>
          <tr><th scope="row">Final reviews with findings</th>{models.map(model => <td key={model.id}>{model.withFindings}</td>)}</tr>
          <tr><th scope="row">Unavailable reviews</th>{models.map(model => <td key={model.id}>{model.unavailable}</td>)}</tr>
          {expanded && <tr><th scope="row">Suppressed findings</th>{models.map(model => <td key={model.id}>{model.suppressed}</td>)}</tr>}
          {expanded && <tr><th scope="row">Provider route</th>{models.map(model => <td key={model.id}>{model.provider}</td>)}</tr>}
        </tbody>
      </table>
      <figcaption className="mt-4 text-sm text-charcoal/70">
        {expanded
          ? <>One run per model on the separate <a href="/bench/screening-0.9.7-clean-bank-v2.json">25-case clean bank</a>, using the same inputs for both models.</>
          : <>The {BENCH.cleanCases} clean cases from the <Link href="/bench">historical 70-case screening report</Link>.</>}
        {" "}Any retained finding counts against
        silence, even a nonblocking warning. Suppressed candidates are separate from final findings.
        Unavailable means no usable review result and does not count as silence.
      </figcaption>
    </figure>
  );
}
