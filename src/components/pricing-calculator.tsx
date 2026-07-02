"use client";

import { useMemo, useState } from "react";

const CODERABBIT_PRO_SEAT = 24; // $/user/mo, annual billing
const POSTIL_SEAT = 10;

const GREPTILE = {
  seat: 30,
  includedReviewsPerDev: 50,
  overagePerReview: 1,
} as const;

const MODEL_PRICES = [
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    input: 0.000000435,
    output: 0.00000087,
    note: "default balance",
  },
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    input: 0.00000009,
    output: 0.00000018,
    note: "lowest cost",
  },
  {
    id: "qwen/qwen3.7-plus",
    label: "Qwen3.7 Plus",
    input: 0.00000032,
    output: 0.00000128,
    note: "fast coding",
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    input: 0.00000074,
    output: 0.0000035,
    note: "code-focused",
  },
  {
    id: "z-ai/glm-5.2",
    label: "GLM 5.2",
    input: 0.0000014,
    output: 0.0000044,
    note: "long-horizon",
  },
  {
    id: "minimax/minimax-m3",
    label: "MiniMax M3",
    input: 0.0000003,
    output: 0.0000012,
    note: "1M context",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    label: "Nemotron 3 Ultra",
    input: 0.0000005,
    output: 0.0000022,
    note: "open frontier",
  },
] as const;

function dollars(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function perReviewCost(model: (typeof MODEL_PRICES)[number], prompt: number, completion: number): number {
  return prompt * model.input + completion * model.output;
}

export function PricingCalculator() {
  const [devs, setDevs] = useState(25);
  const [prsPerDev, setPrsPerDev] = useState(40);
  const [promptTokens, setPromptTokens] = useState(978);
  const [completionTokens, setCompletionTokens] = useState(544);
  const [modelId, setModelId] = useState<(typeof MODEL_PRICES)[number]["id"]>(
    "deepseek/deepseek-v4-pro",
  );
  const [billingMode, setBillingMode] = useState<"byok" | "managed">("managed");
  const [markupBps, setMarkupBps] = useState(300);

  const result = useMemo(() => {
    const model = MODEL_PRICES.find((m) => m.id === modelId) ?? MODEL_PRICES[0];
    const reviews = devs * prsPerDev;
    const rawInferencePerReview = perReviewCost(model, promptTokens, completionTokens);
    const markup = billingMode === "managed" ? markupBps / 10_000 : 0;
    const inferencePerReview = rawInferencePerReview * (1 + markup);
    const inference = reviews * inferencePerReview;
    const postil = devs * POSTIL_SEAT + inference;
    const coderabbit = devs * CODERABBIT_PRO_SEAT;
    const overageReviewsPerDev = Math.max(0, prsPerDev - GREPTILE.includedReviewsPerDev);
    const greptile =
      devs * GREPTILE.seat +
      devs * overageReviewsPerDev * GREPTILE.overagePerReview;
    return {
      model,
      reviews,
      rawInferencePerReview,
      inferencePerReview,
      inference,
      postil,
      coderabbit,
      greptile,
      savings: coderabbit - postil,
      savingsVsGreptile: greptile - postil,
      markup,
    };
  }, [billingMode, completionTokens, devs, markupBps, modelId, promptTokens, prsPerDev]);

  return (
    <div className="card p-6 md:p-8">
      <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr]">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium">Model</span>
              <select
                value={modelId}
                onChange={(e) =>
                  setModelId(e.target.value as (typeof MODEL_PRICES)[number]["id"])
                }
                className="mt-2 w-full rounded-card border border-stone bg-ivory px-3 py-2 text-sm"
              >
                {MODEL_PRICES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.note}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Inference billing</span>
              <select
                value={billingMode}
                onChange={(e) => setBillingMode(e.target.value as "byok" | "managed")}
                className="mt-2 w-full rounded-card border border-stone bg-ivory px-3 py-2 text-sm"
              >
                <option value="managed">Managed key</option>
                <option value="byok">Bring your own key</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="flex justify-between text-sm">
              <span className="font-medium">Developers</span>
              <span className="font-mono" aria-hidden="true">
                {devs}
              </span>
            </span>
            <input
              type="range"
              min={1}
              max={200}
              value={devs}
              aria-valuetext={`${devs} developers`}
              onChange={(e) => setDevs(Number(e.target.value))}
              className="slider mt-2 w-full"
            />
          </label>

          <label className="block">
            <span className="flex justify-between text-sm">
              <span className="font-medium">PRs per developer per month</span>
              <span className="font-mono" aria-hidden="true">
                {prsPerDev}
              </span>
            </span>
            <input
              type="range"
              min={5}
              max={600}
              step={5}
              value={prsPerDev}
              aria-valuetext={`${prsPerDev} PRs per developer per month`}
              onChange={(e) => setPrsPerDev(Number(e.target.value))}
              className="slider mt-2 w-full"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="flex justify-between text-sm">
                <span className="font-medium">Prompt tokens</span>
                <span className="font-mono" aria-hidden="true">
                  {promptTokens.toLocaleString()}
                </span>
              </span>
              <input
                type="range"
                min={500}
                max={30000}
                step={250}
                value={promptTokens}
                aria-valuetext={`${promptTokens} prompt tokens`}
                onChange={(e) => setPromptTokens(Number(e.target.value))}
                className="slider mt-2 w-full"
              />
            </label>
            <label className="block">
              <span className="flex justify-between text-sm">
                <span className="font-medium">Completion tokens</span>
                <span className="font-mono" aria-hidden="true">
                  {completionTokens.toLocaleString()}
                </span>
              </span>
              <input
                type="range"
                min={100}
                max={5000}
                step={50}
                value={completionTokens}
                aria-valuetext={`${completionTokens} completion tokens`}
                onChange={(e) => setCompletionTokens(Number(e.target.value))}
                className="slider mt-2 w-full"
              />
            </label>
          </div>

          {billingMode === "managed" ? (
            <label className="block">
              <span className="flex justify-between text-sm">
                <span className="font-medium">Managed inference markup</span>
                <span className="font-mono" aria-hidden="true">
                  {(markupBps / 100).toFixed(1)}%
                </span>
              </span>
              <input
                type="range"
                min={50}
                max={500}
                step={25}
                value={markupBps}
                aria-valuetext={`${(markupBps / 100).toFixed(1)} percent markup`}
                onChange={(e) => setMarkupBps(Number(e.target.value))}
                className="slider mt-2 w-full"
              />
              <span className="mt-1 block text-xs text-charcoal/70">
                BYOK uses provider rates directly. Managed mode adds only the
                selected pass-through markup for billing and key handling.
              </span>
            </label>
          ) : (
            <p className="text-xs text-charcoal/70">
              BYOK means the model bill lands in your provider account. Postil
              adds zero inference markup.
            </p>
          )}
        </div>

        <div className="flex flex-col justify-between gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-card border border-gate bg-ivory p-4">
              <p className="eyebrow">Postil</p>
              <p className="serif-display mt-2 text-3xl">{dollars(result.postil)}</p>
              <p className="mt-1 text-xs text-charcoal/70">
                {dollars(devs * POSTIL_SEAT)} orchestration +{" "}
                {dollars(result.inference, 2)} inference
              </p>
            </div>
            <div className="rounded-card border border-stone bg-ivory p-4">
              <p className="eyebrow text-charcoal/70">CodeRabbit Pro</p>
              <p className="serif-display mt-2 text-3xl">{dollars(result.coderabbit)}</p>
              <p className="mt-1 text-xs text-charcoal/70">$24/seat/mo, annual</p>
            </div>
            <div className="rounded-card border border-stone bg-ivory p-4">
              <p className="eyebrow text-charcoal/70">Greptile</p>
              <p className="serif-display mt-2 text-3xl">{dollars(result.greptile)}</p>
              <p className="mt-1 text-xs text-charcoal/70">
                ${GREPTILE.seat}/seat + ${GREPTILE.overagePerReview}/review past{" "}
                {GREPTILE.includedReviewsPerDev}/dev
              </p>
            </div>
          </div>

          <div className="rounded-card border border-stone bg-stone/60 p-5">
            <p className="eyebrow">Selected model</p>
            <p className="mt-2 font-mono text-xs text-charcoal/80">{result.model.id}</p>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-charcoal/70">Input</dt>
                <dd className="font-mono">{dollars(result.model.input * 1_000_000, 3)}/1M</dd>
              </div>
              <div>
                <dt className="text-charcoal/70">Output</dt>
                <dd className="font-mono">{dollars(result.model.output * 1_000_000, 3)}/1M</dd>
              </div>
              <div>
                <dt className="text-charcoal/70">Raw inference/review</dt>
                <dd className="font-mono">{dollars(result.rawInferencePerReview, 4)}</dd>
              </div>
              <div>
                <dt className="text-charcoal/70">Billed inference/review</dt>
                <dd className="font-mono">{dollars(result.inferencePerReview, 4)}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-card bg-charcoal p-5 text-ivory">
            <p className="text-sm text-ivory/70">
              Monthly difference across {result.reviews.toLocaleString()} reviews
            </p>
            <p className="serif-display mt-1 text-3xl">
              {result.savings >= 0
                ? `${dollars(result.savings)} saved vs CodeRabbit`
                : `${dollars(-result.savings)} more than CodeRabbit`}
            </p>
            <p className="mt-1 text-sm text-ivory/80">
              {result.savingsVsGreptile >= 0
                ? `${dollars(result.savingsVsGreptile)} saved vs Greptile`
                : `${dollars(-result.savingsVsGreptile)} more than Greptile`}
            </p>
            <p className="mt-2 text-xs text-ivory/60">
              Evidence fixtures average 978 prompt and 544 completion tokens.
              Large diffs cost more; local models cost whatever your hardware does.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
