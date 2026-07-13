"use client";

import { useMemo, useState } from "react";

import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  calculatePostilPricing,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
} from "@/lib/pricing-policy";

const CODERABBIT_PRO_SEAT = 24;
const GREPTILE_PRO_SEAT = 30;
const COPILOT_BUSINESS_SEAT = 19;
const MAX_ACTIVE_AUTHORS = 200;
const QODO_SELF_SERVE_MAX_DEVELOPERS = 30;

function dollars(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function PriceCard({ detail, label, total, unit }: {
  detail: string;
  label: string;
  total: string;
  unit: string;
}) {
  return (
    <div className="bg-ivory p-4 text-charcoal">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-gate">{label}</p>
      <p className="serif-display mt-2 text-3xl">{unit}</p>
      <p className="mt-1 text-sm text-charcoal/72">{total}</p>
      <p className="mt-3 text-xs leading-relaxed text-charcoal/60">{detail}</p>
    </div>
  );
}

export function PricingCalculator() {
  const [activeAuthors, setActiveAuthors] = useState(25);
  const atLimit = activeAuthors === MAX_ACTIVE_AUTHORS;
  const pricing = useMemo(
    () => calculatePostilPricing(activeAuthors),
    [activeAuthors],
  );

  return (
    <div className="overflow-hidden rounded-card border border-stone bg-paper shadow-card">
      <div className="grid lg:grid-cols-[0.62fr_1.38fr]">
        <div className="border-b border-stone p-5 md:p-6 lg:border-r lg:border-b-0">
          <p className="eyebrow">Private-repository activity</p>
          <h3 className="serif-display mt-2 text-2xl">Pay for active authors.</h3>
          <label className="mt-7 block">
            <span className="flex justify-between gap-4 text-sm">
              <span className="font-medium">Active PR authors</span>
              <span className="font-mono" aria-hidden="true">
                {atLimit ? "200+" : activeAuthors.toLocaleString("en-US")}
              </span>
            </span>
            <input
              type="range"
              min={1}
              max={MAX_ACTIVE_AUTHORS}
              value={activeAuthors}
              aria-valuetext={atLimit ? "200 or more active authors" : `${activeAuthors} active authors`}
              onInput={(event) => setActiveAuthors(Number(event.currentTarget.value))}
              onChange={(event) => setActiveAuthors(Number(event.currentTarget.value))}
              className="slider mt-2 w-full"
            />
          </label>
          <p className="mt-5 text-sm text-charcoal/70">
            An active author is a GitHub identity, including a bot or service
            identity, whose private-repository PR Postil reviews that month.
            Repositories are not billed.
          </p>
        </div>

        <div className="p-5 md:p-6">
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-stone bg-stone sm:grid-cols-2 xl:grid-cols-3">
            <PriceCard
              label="Postil Hosted"
              unit={`${dollars(HOSTED_ACTIVE_AUTHOR_MONTHLY_USD)}/author`}
              total={`${dollars(pricing.hostedMonthlyUsd)} / mo`}
              detail={`${dollars(pricing.hostedInferenceAllowanceUsd)} pooled inference allowance; overages default to $0`}
            />
            <PriceCard
              label="Postil BYOK"
              unit={`${dollars(BYOK_ACTIVE_AUTHOR_MONTHLY_USD)}/author`}
              total={`${dollars(pricing.byokMonthlyUsd)} / mo`}
              detail="Provider usage is billed directly to your provider account"
            />
            <PriceCard
              label="CodeRabbit Pro"
              unit={`${dollars(CODERABBIT_PRO_SEAT)}/developer`}
              total={`${dollars(CODERABBIT_PRO_SEAT * activeAuthors)} / mo`}
              detail="Annual list price; unit is all licensed developers"
            />
            <PriceCard
              label="Greptile Pro"
              unit={`${dollars(GREPTILE_PRO_SEAT)}/developer`}
              total={`${dollars(GREPTILE_PRO_SEAT * activeAuthors)} / mo + usage`}
              detail="50 review credits per seat, then usage overage"
            />
            <PriceCard
              label="Qodo Pro Team"
              unit="$0.012/credit"
              total={activeAuthors > QODO_SELF_SERVE_MAX_DEVELOPERS ? "Enterprise custom" : "From $30 / mo"}
              detail="Credit packs pooled across the workspace"
            />
            <PriceCard
              label="Macroscope"
              unit="$0.05/KB"
              total="Usage-based"
              detail="$0.50 minimum per review, no seat fee"
            />
            <PriceCard
              label="Copilot Business"
              unit={`${dollars(COPILOT_BUSINESS_SEAT)}/developer`}
              total={`${dollars(COPILOT_BUSINESS_SEAT * activeAuthors)} / mo + usage`}
              detail="Seat price plus AI-credit and Actions usage"
            />
          </div>
          <p className="mt-5 text-sm text-charcoal/70">
            Postil counts active private-PR authors. Competitor totals use their
            published billing units, so compare against the identities or seats
            each vendor would actually bill.
          </p>
        </div>
      </div>
    </div>
  );
}
