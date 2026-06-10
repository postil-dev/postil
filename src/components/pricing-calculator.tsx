"use client";

import { useMemo, useState } from "react";

const CODERABBIT_PRO_SEAT = 24; // $/user/mo, annual billing
const POSTIL_SEAT = 10;

function dollars(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * Cost calculator: flat Postil orchestration + BYO inference passthrough
 * versus CodeRabbit Pro at $24/seat/mo (annual). Inference cost per review
 * is a user-adjustable estimate because it depends entirely on the model
 * and diff size on the customer's own key.
 */
export function PricingCalculator() {
  const [devs, setDevs] = useState(25);
  const [prsPerDev, setPrsPerDev] = useState(40);
  const [centsPerReview, setCentsPerReview] = useState(2);

  const result = useMemo(() => {
    const reviews = devs * prsPerDev;
    const inference = (reviews * centsPerReview) / 100;
    const postil = devs * POSTIL_SEAT + inference;
    const coderabbit = devs * CODERABBIT_PRO_SEAT;
    return { reviews, inference, postil, coderabbit, savings: coderabbit - postil };
  }, [devs, prsPerDev, centsPerReview]);

  return (
    <div className="card p-6 md:p-8">
      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-6">
          <label className="block">
            <span className="flex justify-between text-sm">
              <span className="font-medium">Developers</span>
              <span className="font-mono">{devs}</span>
            </span>
            <input
              type="range"
              min={1}
              max={200}
              value={devs}
              onChange={(e) => setDevs(Number(e.target.value))}
              className="mt-2 w-full accent-[#C24A2A]"
            />
          </label>
          <label className="block">
            <span className="flex justify-between text-sm">
              <span className="font-medium">PRs per developer per month</span>
              <span className="font-mono">{prsPerDev}</span>
            </span>
            <input
              type="range"
              min={5}
              max={600}
              step={5}
              value={prsPerDev}
              onChange={(e) => setPrsPerDev(Number(e.target.value))}
              className="mt-2 w-full accent-[#C24A2A]"
            />
            <span className="mt-1 block text-xs text-charcoal/50">
              Agentic teams report 50-571 PRs per developer per month.
            </span>
          </label>
          <label className="block">
            <span className="flex justify-between text-sm">
              <span className="font-medium">Estimated inference per review (your key)</span>
              <span className="font-mono">{(centsPerReview / 100).toFixed(2)} USD</span>
            </span>
            <input
              type="range"
              min={0}
              max={20}
              value={centsPerReview}
              onChange={(e) => setCentsPerReview(Number(e.target.value))}
              className="mt-2 w-full accent-[#C24A2A]"
            />
            <span className="mt-1 block text-xs text-charcoal/50">
              Paid to your provider at their rates. Postil adds zero markup.
            </span>
          </label>
        </div>

        <div className="flex flex-col justify-between gap-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-card border border-gate bg-ivory p-4">
              <p className="eyebrow">Postil</p>
              <p className="serif-display mt-2 text-3xl">{dollars(result.postil)}</p>
              <p className="mt-1 text-xs text-charcoal/60">
                {dollars(devs * POSTIL_SEAT)} orchestration
                {result.inference > 0 && (
                  <> + {dollars(result.inference)} inference on your key</>
                )}
              </p>
            </div>
            <div className="rounded-card border border-stone bg-ivory p-4">
              <p className="eyebrow text-charcoal/50">CodeRabbit Pro</p>
              <p className="serif-display mt-2 text-3xl">{dollars(result.coderabbit)}</p>
              <p className="mt-1 text-xs text-charcoal/60">
                $24/seat/mo, annual billing
              </p>
            </div>
          </div>
          <div className="rounded-card bg-charcoal p-5 text-ivory">
            <p className="text-sm text-ivory/70">
              Monthly difference across {result.reviews.toLocaleString()} reviews
            </p>
            <p className="serif-display mt-1 text-3xl">
              {result.savings >= 0
                ? `${dollars(result.savings)} saved with Postil`
                : `${dollars(-result.savings)} more with Postil`}
            </p>
            <p className="mt-2 text-xs text-ivory/60">
              And the hosted beta is currently free, so today's number is{" "}
              {dollars(result.inference)}.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
