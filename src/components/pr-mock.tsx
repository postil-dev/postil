import { StatusIcon } from "@/components/status-icon";

/**
 * Illustrative mock of the Postil product surface on a GitHub pull request:
 * the two check-runs (one gate failed, one advisory) and a single inline
 * finding with a confidence score. This is a hand-built illustration, not a
 * screenshot of a live PR. Real screenshots are pending.
 */
export function PrMock() {
  return (
    <figure className="card overflow-hidden font-sans">
      {/* Mock browser/PR header */}
      <div className="flex items-center justify-between border-b border-stone bg-paper px-4 py-2.5">
        <div className="flex items-center gap-2 font-mono text-xs text-charcoal/70">
          <span className="h-2.5 w-2.5 rounded-full bg-stone" />
          <span className="h-2.5 w-2.5 rounded-full bg-stone" />
          <span className="h-2.5 w-2.5 rounded-full bg-stone" />
          <span className="ml-2">github.com/acme/payments · #4127</span>
        </div>
        <span className="rounded-full border border-stone px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-charcoal/70">
          illustrative
        </span>
      </div>

      <div className="space-y-5 p-5">
        <div>
          <p className="serif-display text-lg text-charcoal">
            Add refund webhook handler
          </p>
          <p className="mt-0.5 font-mono text-xs text-charcoal/70">
            feat/refund-webhook → main · 4 files, +212 −18
          </p>
        </div>

        {/* Checks block */}
        <div className="rounded-card border border-stone">
          <p className="border-b border-stone px-4 py-2 text-sm font-medium text-charcoal">
            Some checks were not successful
          </p>
          <ul className="divide-y divide-stone text-sm">
            <li className="flex items-center gap-3 px-4 py-2.5">
              <StatusIcon kind="error" size={16} />
              <span className="font-mono text-charcoal">postil/gate</span>
              <span className="text-rust">Failing</span>
              <span className="ml-auto text-charcoal/70">
                1 gate-level finding (severity error)
              </span>
            </li>
            <li className="flex items-center gap-3 px-4 py-2.5">
              <StatusIcon kind="warn" size={16} />
              <span className="font-mono text-charcoal">postil/review</span>
              <span className="text-gate">Neutral</span>
              <span className="ml-auto text-charcoal/70">2 advisory comments</span>
            </li>
          </ul>
        </div>

        {/* Inline finding */}
        <div className="rounded-card border border-stone">
          <div className="flex items-center gap-2 border-b border-stone bg-paper px-4 py-2 font-mono text-xs text-charcoal/70">
            <span>src/billing/invoice.ts</span>
            <span className="text-charcoal/70">·</span>
            <span>line 84</span>
          </div>
          <div className="bg-charcoal px-4 py-2.5 font-mono text-xs text-ivory/90">
            <span className="text-ivory/60">84</span>{"  "}
            <span className="text-softred">- await issueRefund(charge.id)</span>
            <br />
            <span className="text-ivory/60">84</span>{"  "}
            <span className="text-[#a9bd9b]">
              + await issueRefund(charge.id, {"{"} idempotencyKey {"}"})
            </span>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2">
              <StatusIcon kind="error" size={14} />
              <span className="text-sm font-medium text-charcoal">
                Postil — gate finding
              </span>
              <span className="ml-auto font-mono text-[11px] text-charcoal/70">
                confidence 0.91 · kind: risk
              </span>
            </div>
            <p className="mt-2 text-sm text-ink-soft">
              The refund path does not pass an idempotency key. A retried webhook
              delivery will issue a second refund and double-credit the customer.
              Pass the event id as the idempotency key before calling the
              provider.
            </p>
          </div>
        </div>
      </div>

      <figcaption className="border-t border-stone px-5 py-3 font-mono text-[11px] text-charcoal/70">
        Illustration of the Postil PR surface. Not a screenshot of a live pull
        request.
      </figcaption>
    </figure>
  );
}
