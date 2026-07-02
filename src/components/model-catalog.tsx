"use client";

import { useEffect, useState } from "react";

import { MODELS, type CatalogModel } from "@/data/models";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CACHE_KEY = "postil:openrouter-models:v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface OpenRouterPricing {
  prompt: string;
  completion: string;
}

interface OpenRouterModel {
  id: string;
  pricing: OpenRouterPricing;
}

interface PriceEntry {
  input: number;
  output: number;
}

type PriceMap = Record<string, PriceEntry>;

type FetchState =
  | { status: "loading" }
  | { status: "ready"; prices: PriceMap }
  | { status: "error" };

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
    // sessionStorage unavailable (private mode, quota) — pricing still
    // renders for this page view, it just refetches next time.
  }
}

function dollarsPerMillion(pricePerToken: number): string {
  return (pricePerToken * 1_000_000).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K ctx`;
  return `${tokens} ctx`;
}

function Badge({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "accent" | "muted";
}) {
  const toneClass =
    tone === "accent"
      ? "border-gate text-gate"
      : tone === "muted"
        ? "border-stone text-charcoal/60"
        : "border-stone text-charcoal/80";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] whitespace-nowrap ${toneClass}`}
    >
      {children}
    </span>
  );
}

function ModelBadges({ model }: { model: CatalogModel }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      <Badge>{contextLabel(model.contextLength)}</Badge>
      {model.vision && <Badge tone="accent">vision</Badge>}
      <Badge tone={model.openWeights ? "accent" : "muted"}>
        {model.openWeights ? "open-weights" : "proprietary"}
      </Badge>
      {model.paramClass !== "unknown" && (
        <Badge tone={model.locallyRunnable ? "accent" : "default"}>
          {model.paramClass}
          {model.locallyRunnable ? " · locally runnable" : ""}
        </Badge>
      )}
      {!model.tested && <Badge tone="muted">untested</Badge>}
    </div>
  );
}

function PriceCell({ state, id }: { state: FetchState; id: string }) {
  if (state.status === "loading") {
    return <span className="text-charcoal/50">loading…</span>;
  }
  if (state.status === "error") {
    return <span className="text-charcoal/50">pricing unavailable</span>;
  }
  const price = state.prices[id];
  if (!price) {
    return <span className="text-charcoal/50">pricing unavailable</span>;
  }
  return (
    <span className="font-mono text-[13px]">
      {dollarsPerMillion(price.input)} in / {dollarsPerMillion(price.output)} out
    </span>
  );
}

export function ModelCatalog() {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const cached = readCache();
    if (cached) {
      setState({ status: "ready", prices: cached });
      return;
    }

    fetch(CATALOG_URL, { headers: { Accept: "application/json" } })
      .then((res) => {
        if (!res.ok) throw new Error(`OpenRouter catalog returned ${res.status}`);
        return res.json();
      })
      .then((json: { data: OpenRouterModel[] }) => {
        if (cancelled) return;
        const prices: PriceMap = {};
        for (const m of json.data ?? []) {
          const promptPrice = Number(m.pricing?.prompt);
          const completionPrice = Number(m.pricing?.completion);
          if (Number.isFinite(promptPrice) && Number.isFinite(completionPrice)) {
            prices[m.id] = { input: promptPrice, output: completionPrice };
          }
        }
        writeCache(prices);
        setState({ status: "ready", prices });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
              Model
            </th>
            <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
              Capabilities
            </th>
            <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
              Price / 1M tokens
            </th>
          </tr>
        </thead>
        <tbody>
          {MODELS.map((model) => (
            <tr key={model.id}>
              <td className="border-b border-stone py-3 pr-3 align-top">
                <a
                  href={`https://openrouter.ai/${model.id}`}
                  rel="noopener"
                  className="font-medium text-rust underline underline-offset-2"
                >
                  {model.name}
                </a>
                {model.recommended && (
                  <span className="ml-2">
                    <Badge tone="accent">default</Badge>
                  </span>
                )}
                <br />
                <code className="text-xs text-charcoal/70">{model.id}</code>
              </td>
              <td className="border-b border-stone py-3 pr-3 align-top">
                <ModelBadges model={model} />
              </td>
              <td className="border-b border-stone py-3 pr-3 align-top">
                <PriceCell state={state} id={model.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-charcoal/60">
        Prices are fetched live from the{" "}
        <a href="https://openrouter.ai/models" rel="noopener" className="text-rust underline">
          OpenRouter catalog
        </a>{" "}
        on page load and cached in your browser for up to an hour. Capability
        badges (context length, vision, open-weights, parameter class) are
        maintained in this repo and re-verified against the live catalog
        periodically.
      </p>
    </div>
  );
}
