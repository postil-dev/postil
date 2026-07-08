"use client";

import { useMemo, useState } from "react";

const POSTIL_SEAT = 10;
// Public list prices for customer-facing comparison cards.
const CODERABBIT_PRO_SEAT = 24;
const GREPTILE_PRO_SEAT = 30;
const COPILOT_BUSINESS_SEAT = 19;
const SELF_SERVE_MAX_DEVELOPERS = 200;
const QODO_SELF_SERVE_MAX_DEVELOPERS = 30;

function dollars(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function monthly(pricePerSeat: number, seats: number): string {
  return dollars(pricePerSeat * seats);
}

function total(pricePerSeat: number, seats: number): string {
  return monthly(pricePerSeat, seats) + " / mo";
}

function floorTotal(pricePerSeat: number): string {
  return "From " + monthly(pricePerSeat, SELF_SERVE_MAX_DEVELOPERS) + " / mo";
}

function PriceCard({
  detail,
  emphasized = false,
  label,
  totalLabel,
  value,
}: {
  detail: string;
  emphasized?: boolean;
  label: string;
  totalLabel: string;
  value: string;
}) {
  return (
    <div
      className={"p-4 " + (emphasized ? "bg-charcoal text-ivory" : "bg-ivory text-charcoal")}
    >
      <p
        className={
          "font-mono text-[10px] tracking-[0.16em] uppercase " +
          (emphasized ? "text-ivory/65" : "text-gate")
        }
      >
        {label}
      </p>
      <p className="serif-display mt-2 text-3xl">{value}</p>
      <p className={"mt-1 text-sm " + (emphasized ? "text-ivory/78" : "text-charcoal/72")}>
        {totalLabel}
      </p>
      <p className={"mt-3 text-xs leading-relaxed " + (emphasized ? "text-ivory/62" : "text-charcoal/60")}>
        {detail}
      </p>
    </div>
  );
}

export function PricingCalculator() {
  const [developers, setDevelopers] = useState(25);
  const contactUs = developers === SELF_SERVE_MAX_DEVELOPERS;
  const developerLabel = contactUs ? "200+" : formatNumber(developers);
  const qodoEnterprise = developers > QODO_SELF_SERVE_MAX_DEVELOPERS;

  const comparison = useMemo(
    () => ({
      postil: contactUs ? "Contact us" : total(POSTIL_SEAT, developers),
      coderabbit: contactUs
        ? floorTotal(CODERABBIT_PRO_SEAT)
        : total(CODERABBIT_PRO_SEAT, developers),
      copilot: contactUs
        ? floorTotal(COPILOT_BUSINESS_SEAT)
        : total(COPILOT_BUSINESS_SEAT, developers) + "+",
      greptile: contactUs
        ? floorTotal(GREPTILE_PRO_SEAT)
        : total(GREPTILE_PRO_SEAT, developers) + "+",
      qodo: qodoEnterprise ? "Enterprise custom" : "From $30 / mo",
      qodoDetail: qodoEnterprise
        ? "Enterprise pricing applies above the public self-serve team range"
        : "Credit packs pooled across the team; self-serve up to 30 users",
      savingsVsCodeRabbit: (CODERABBIT_PRO_SEAT - POSTIL_SEAT) * developers,
      savingsVsCopilot: (COPILOT_BUSINESS_SEAT - POSTIL_SEAT) * developers,
    }),
    [contactUs, developers, qodoEnterprise],
  );

  return (
    <div className="overflow-hidden rounded-card border border-stone bg-paper shadow-card">
      <div className="grid lg:grid-cols-[0.62fr_1.38fr]">
        <div className="border-b border-stone p-5 md:p-6 lg:border-r lg:border-b-0">
          <div>
            <p className="eyebrow">Team size</p>
            <h3 className="serif-display mt-2 text-2xl">One number. No usage meter.</h3>
          </div>

          <label className="mt-7 block">
            <span className="flex justify-between gap-4 text-sm">
              <span className="font-medium">Developers</span>
              <span className="font-mono" aria-hidden="true">
                {developerLabel}
              </span>
            </span>
            <input
              type="range"
              min={1}
              max={SELF_SERVE_MAX_DEVELOPERS}
              value={developers}
              aria-valuetext={
                contactUs ? "200 or more developers" : developers + " developers"
              }
              onInput={(event) => setDevelopers(Number(event.currentTarget.value))}
              onChange={(event) => setDevelopers(Number(event.currentTarget.value))}
              className="slider mt-2 w-full"
            />
          </label>

          <div className="mt-5 rounded-card border border-gate/30 bg-gate/10 px-3 py-2 text-sm text-gate">
            <span className="font-mono text-[11px] tracking-[0.12em] uppercase">
              Included
            </span>
            <span className="ml-2 font-medium">hosted reviews on every push</span>
          </div>

          {contactUs ? (
            <p className="mt-4 text-sm text-charcoal/70">
              At 200 or more developers, procurement, security, and billing get
              handled directly.
            </p>
          ) : (
            <p className="mt-4 text-sm text-charcoal/70">
              Move the seat count only. Competitors with usage pricing are
              shown as public list-price floors, not inferred bills.
            </p>
          )}
        </div>

        <div className="p-5 md:p-6">
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-stone bg-stone sm:grid-cols-2 xl:grid-cols-3">
            <PriceCard
              emphasized
              label="Postil"
              value={contactUs ? "Custom" : dollars(POSTIL_SEAT) + "/dev"}
              totalLabel={comparison.postil}
              detail={
                contactUs
                  ? "Custom contract above the public self-serve range"
                  : "Flat seat price, hosted reviews included"
              }
            />
            <PriceCard
              label="CodeRabbit Pro"
              value={dollars(CODERABBIT_PRO_SEAT) + "/dev"}
              totalLabel={comparison.coderabbit}
              detail="Annual list price, unlimited PR reviews"
            />
            <PriceCard
              label="Greptile Pro"
              value={dollars(GREPTILE_PRO_SEAT) + "/dev"}
              totalLabel={comparison.greptile}
              detail="50 review credits per seat, then usage overage"
            />
            <PriceCard
              label="Qodo Pro Team"
              value="$0.012/credit"
              totalLabel={comparison.qodo}
              detail={comparison.qodoDetail}
            />
            <PriceCard
              label="Macroscope"
              value="$0.05/KB"
              totalLabel="Usage-based"
              detail="$0.50 minimum per review, no seat fee"
            />
            <PriceCard
              label="Copilot Business"
              value={dollars(COPILOT_BUSINESS_SEAT) + "/dev"}
              totalLabel={comparison.copilot}
              detail="Seat price plus AI-credit and Actions usage"
            />
          </div>

          <div className="mt-5 rounded-card bg-charcoal p-5 text-ivory">
            {contactUs ? (
              <>
                <p className="text-sm text-ivory/70">Self-serve comparison stops here.</p>
                <p className="serif-display mt-1 text-3xl">Contact us for 200+ developers.</p>
                <p className="mt-1 text-sm text-ivory/80">
                  Competitors show floors, usage labels, or custom enterprise
                  pricing; enterprise procurement gets handled directly.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-ivory/70">
                  Monthly savings at {developerLabel} developers
                </p>
                <p className="serif-display mt-1 text-3xl">
                  {dollars(comparison.savingsVsCodeRabbit)} vs CodeRabbit
                </p>
                <p className="mt-1 text-sm text-ivory/80">
                  {dollars(comparison.savingsVsCopilot)} vs Copilot Business,
                  before Copilot review usage.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
