"use client";

import { useEffect, useMemo, useState } from "react";

import benchData from "@/data/bench-results.json";
import { MODELS } from "@/data/models";

const CODERABBIT_PRO_SEAT = 24; // $/user/mo, annual billing
const POSTIL_SEAT = 10;

const GREPTILE = {
  seat: 30,
  includedReviewsPerDev: 50,
  overagePerReview: 1,
} as const;

interface PriceEntry {
  input: number;
  output: number;
}

type PriceMap = Record<string, PriceEntry>;

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CACHE_KEY = "postil:pricing-openrouter-models:v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

const PRICE_FALLBACK: PriceMap = {
  "deepseek/deepseek-v4-pro": { input: 0.000000435, output: 0.00000087 },
  "moonshotai/kimi-k2.6": { input: 0.00000066, output: 0.00000341 },
  "qwen/qwen3-32b": { input: 0.00000008, output: 0.00000028 },
  "mistralai/mistral-small-3.2-24b-instruct": {
    input: 0.000000075,
    output: 0.0000002,
  },
  "google/gemma-3-27b-it": { input: 0.00000008, output: 0.00000016 },
};

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface BenchModelResult {
  id: string;
  detectionRate: number;
  falsePositives: number;
  casesRun: number;
  meanCostUsdPerReview: number;
  meanDurationMs: number;
}

interface BenchResults {
  generatedAt: string;
  cliVersion: string;
  models: BenchModelResult[];
}

interface ModelOption {
  id: string;
  name: string;
  fallbackPrice: PriceEntry;
  bench: BenchModelResult;
}

type BillingMode = "managed" | "byok";
type CostMode = "bench" | "custom";

const BENCH = benchData as BenchResults;

const MODEL_OPTIONS: ModelOption[] = BENCH.models
  .map((bench) => {
    const model = MODELS.find((m) => m.id === bench.id);
    const fallbackPrice = PRICE_FALLBACK[bench.id];
    if (!model || !fallbackPrice) return null;
    return { id: bench.id, name: model.name, fallbackPrice, bench };
  })
  .filter((model): model is ModelOption => model !== null);

const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-pro";

function dollars(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function preciseDollars(n: number): string {
  return dollars(n, n >= 1 ? 2 : 4);
}

function dollarsPerMillion(pricePerToken: number): string {
  return dollars(pricePerToken * 1_000_000, 3);
}

function percent(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function perReviewCost(price: PriceEntry, prompt: number, completion: number): number {
  return prompt * price.input + completion * price.output;
}

function readCache(): PriceMap | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { fetchedAt: number; prices: PriceMap };
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.prices;
  } catch {
    return null;
  }
}

function writeCache(prices: PriceMap): void {
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), prices }),
    );
  } catch {
    // Pricing still renders with the fallback snapshot.
  }
}

function SegmentButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-10 flex-1 rounded-[4px] px-3 py-2 text-sm transition ${
        active
          ? "bg-charcoal text-ivory"
          : "text-charcoal/70 hover:bg-stone/70 hover:text-charcoal"
      }`}
    >
      {children}
    </button>
  );
}

export function PricingCalculator() {
  const [devs, setDevs] = useState(25);
  const [prsPerDev, setPrsPerDev] = useState(40);
  const [promptTokens, setPromptTokens] = useState(978);
  const [completionTokens, setCompletionTokens] = useState(544);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [billingMode, setBillingMode] = useState<BillingMode>("managed");
  const [costMode, setCostMode] = useState<CostMode>("bench");
  const [prices, setPrices] = useState<PriceMap>(PRICE_FALLBACK);

  useEffect(() => {
    let cancelled = false;

    const cached = readCache();
    if (cached) {
      setPrices((current) => ({ ...current, ...cached }));
      return;
    }

    fetch(CATALOG_URL, { headers: { Accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error(`OpenRouter catalog returned ${response.status}`);
        return response.json();
      })
      .then((json: { data?: OpenRouterModel[] }) => {
        if (cancelled) return;
        const nextPrices: PriceMap = {};
        for (const model of json.data ?? []) {
          const promptPrice = Number(model.pricing?.prompt);
          const completionPrice = Number(model.pricing?.completion);
          if (Number.isFinite(promptPrice) && Number.isFinite(completionPrice)) {
            nextPrices[model.id] = { input: promptPrice, output: completionPrice };
          }
        }
        writeCache(nextPrices);
        setPrices((current) => ({ ...current, ...nextPrices }));
      })
      .catch(() => {
        if (!cancelled) setPrices(PRICE_FALLBACK);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const result = useMemo(() => {
    const selectedModel =
      MODEL_OPTIONS.find((option) => option.id === modelId) ?? MODEL_OPTIONS[0]!;
    const price = prices[selectedModel.id] ?? selectedModel.fallbackPrice;
    const model = { ...selectedModel, price };
    const reviews = devs * prsPerDev;
    const rawInferencePerReview =
      costMode === "bench"
        ? model.bench.meanCostUsdPerReview
        : perReviewCost(price, promptTokens, completionTokens);
    const inference = reviews * rawInferencePerReview;
    const orchestration = devs * POSTIL_SEAT;
    const teamTotal = orchestration + inference;
    const postilInvoice =
      billingMode === "managed" ? orchestration + inference : orchestration;
    const coderabbit = devs * CODERABBIT_PRO_SEAT;
    const overageReviewsPerDev = Math.max(0, prsPerDev - GREPTILE.includedReviewsPerDev);
    const greptile =
      devs * GREPTILE.seat +
      devs * overageReviewsPerDev * GREPTILE.overagePerReview;
    return {
      model,
      reviews,
      rawInferencePerReview,
      inference,
      orchestration,
      teamTotal,
      postilInvoice,
      coderabbit,
      greptile,
      savings: coderabbit - teamTotal,
      savingsVsGreptile: greptile - teamTotal,
    };
  }, [
    billingMode,
    completionTokens,
    costMode,
    devs,
    modelId,
    prices,
    promptTokens,
    prsPerDev,
  ]);

  const modelSpendCopy =
    billingMode === "managed"
      ? "model spend included in the Postil invoice"
      : "model spend paid through your provider account";

  return (
    <div className="overflow-hidden rounded-card border border-stone bg-paper shadow-card">
      <div className="grid lg:grid-cols-[0.96fr_1.04fr]">
        <div className="border-b border-stone p-6 md:p-8 lg:border-r lg:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="eyebrow">Evidence basis</p>
              <h3 className="serif-display mt-2 text-2xl">Measured first.</h3>
            </div>
            <span className="rounded-full border border-gate px-3 py-1 font-mono text-[11px] text-gate">
              {BENCH.models[0]?.casesRun ?? 0} fixture PRs/model
            </span>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium">Model</span>
              <select
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                className="mt-2 w-full rounded-card border border-stone bg-ivory px-3 py-2 text-sm"
              >
                {MODEL_OPTIONS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <span className="text-sm font-medium">Model billing</span>
              <div
                className="mt-2 flex rounded-card border border-stone bg-ivory p-1"
                aria-label="Model billing"
                role="group"
              >
                <SegmentButton
                  active={billingMode === "managed"}
                  onClick={() => setBillingMode("managed")}
                >
                  Managed
                </SegmentButton>
                <SegmentButton
                  active={billingMode === "byok"}
                  onClick={() => setBillingMode("byok")}
                >
                  BYO key
                </SegmentButton>
              </div>
            </div>
          </div>

          <div className="mt-7 space-y-5">
            <label className="block">
              <span className="flex justify-between gap-4 text-sm">
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
                onChange={(event) => setDevs(Number(event.target.value))}
                className="slider mt-2 w-full"
              />
            </label>

            <label className="block">
              <span className="flex justify-between gap-4 text-sm">
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
                onChange={(event) => setPrsPerDev(Number(event.target.value))}
                className="slider mt-2 w-full"
              />
            </label>
          </div>

          <div className="mt-7">
            <span className="text-sm font-medium">Review cost source</span>
            <div
              className="mt-2 flex rounded-card border border-stone bg-ivory p-1"
              aria-label="Review cost source"
              role="group"
            >
              <SegmentButton active={costMode === "bench"} onClick={() => setCostMode("bench")}>
                Bench mean
              </SegmentButton>
              <SegmentButton active={costMode === "custom"} onClick={() => setCostMode("custom")}>
                Custom tokens
              </SegmentButton>
            </div>
          </div>

          {costMode === "bench" ? (
            <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-stone bg-stone text-sm sm:grid-cols-4">
              <div className="bg-ivory p-3">
                <dt className="text-charcoal/60">Mean cost</dt>
                <dd className="mt-1 font-mono font-medium">
                  {preciseDollars(result.model.bench.meanCostUsdPerReview)}
                </dd>
              </div>
              <div className="bg-ivory p-3">
                <dt className="text-charcoal/60">Detection</dt>
                <dd className="mt-1 font-mono font-medium">
                  {percent(result.model.bench.detectionRate)}
                </dd>
              </div>
              <div className="bg-ivory p-3">
                <dt className="text-charcoal/60">Cases</dt>
                <dd className="mt-1 font-mono font-medium">
                  {result.model.bench.casesRun}
                </dd>
              </div>
              <div className="bg-ivory p-3">
                <dt className="text-charcoal/60">False positives</dt>
                <dd className="mt-1 font-mono font-medium">
                  {result.model.bench.falsePositives}
                </dd>
              </div>
            </dl>
          ) : (
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <label className="block">
                <span className="flex justify-between gap-4 text-sm">
                  <span className="font-medium">Prompt tokens</span>
                  <span className="font-mono" aria-hidden="true">
                    {promptTokens.toLocaleString()}
                  </span>
                </span>
                <input
                  type="range"
                  min={250}
                  max={30000}
                  step={1}
                  value={promptTokens}
                  aria-valuetext={`${promptTokens} prompt tokens`}
                  onChange={(event) => setPromptTokens(Number(event.target.value))}
                  className="slider mt-2 w-full"
                />
              </label>
              <label className="block">
                <span className="flex justify-between gap-4 text-sm">
                  <span className="font-medium">Completion tokens</span>
                  <span className="font-mono" aria-hidden="true">
                    {completionTokens.toLocaleString()}
                  </span>
                </span>
                <input
                  type="range"
                  min={50}
                  max={5000}
                  step={1}
                  value={completionTokens}
                  aria-valuetext={`${completionTokens} completion tokens`}
                  onChange={(event) => setCompletionTokens(Number(event.target.value))}
                  className="slider mt-2 w-full"
                />
              </label>
              <p className="text-xs text-charcoal/65 sm:col-span-2">
                Custom tokens are for stress testing unusually large diffs. The
                default uses measured cost from the fixture suite.
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col justify-between gap-6 p-6 md:p-8">
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-stone bg-stone sm:grid-cols-3">
            <div className="bg-ivory p-4">
              <p className="eyebrow">Postil team total</p>
              <p className="serif-display mt-2 text-3xl">{dollars(result.teamTotal)}</p>
              <p className="mt-1 text-xs text-charcoal/70">
                {dollars(result.orchestration)} orchestration +{" "}
                {dollars(result.inference, 2)} model spend
              </p>
            </div>
            <div className="bg-ivory p-4">
              <p className="eyebrow text-charcoal/70">CodeRabbit Pro</p>
              <p className="serif-display mt-2 text-3xl">{dollars(result.coderabbit)}</p>
              <p className="mt-1 text-xs text-charcoal/70">$24/seat/mo, annual</p>
            </div>
            <div className="bg-ivory p-4">
              <p className="eyebrow text-charcoal/70">Greptile</p>
              <p className="serif-display mt-2 text-3xl">{dollars(result.greptile)}</p>
              <p className="mt-1 text-xs text-charcoal/70">
                ${GREPTILE.seat}/seat + ${GREPTILE.overagePerReview}/review past{" "}
                {GREPTILE.includedReviewsPerDev}/dev
              </p>
            </div>
          </div>

          <div className="rounded-card border border-stone bg-stone/55 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="eyebrow">Selected model</p>
                <p className="mt-2 break-words font-mono text-xs text-charcoal/80">
                  {result.model.id}
                </p>
              </div>
              <p className="text-xs text-charcoal/65 sm:max-w-44 sm:text-right">
                {modelSpendCopy}
              </p>
            </div>
            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-charcoal/70">OpenRouter input</dt>
                <dd className="font-mono">{dollarsPerMillion(result.model.price.input)}/1M</dd>
              </div>
              <div>
                <dt className="text-charcoal/70">OpenRouter output</dt>
                <dd className="font-mono">{dollarsPerMillion(result.model.price.output)}/1M</dd>
              </div>
              <div>
                <dt className="text-charcoal/70">Cost used/review</dt>
                <dd className="font-mono">{preciseDollars(result.rawInferencePerReview)}</dd>
              </div>
              <div>
                <dt className="text-charcoal/70">Postil invoice</dt>
                <dd className="font-mono">{dollars(result.postilInvoice, 2)}</dd>
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
            <p className="mt-3 text-xs text-ivory/65">
              Bench mode uses the recorded mean cost from Postil&apos;s fixture
              suite. Custom-token mode is there for large-diff scenarios.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
