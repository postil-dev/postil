import { MODELS } from "@/data/models";

export interface BillingCreditGrantForBalance {
  amountCents: number;
  appliesAt: Date;
}

export interface UsageEventForBillingCredits {
  id: number;
  promptTokens: number;
  completionTokens: number;
  modelUsed: string | null;
  costMicros: number | null;
  createdAt: Date;
}

export interface BillingCreditBalance {
  creditStartsAt: Date | null;
  totalGrantedCents: number;
  usageCostMicros: number;
  remainingMicros: number;
  chargedUsageEvents: number;
  unpricedUsageEvents: number;
}

const MODEL_PRICES = new Map(MODELS.map((model) => [model.id, model.pricePerToken]));

export function calculateBillingCreditBalance(
  grants: BillingCreditGrantForBalance[],
  usageEvents: UsageEventForBillingCredits[],
  options: { asOf?: Date } = {},
): BillingCreditBalance {
  const asOf = options.asOf ?? new Date();
  const appliedGrants = grants.filter((grant) => grant.appliesAt <= asOf);
  const creditStartsAt = earliestAppliesAt(appliedGrants);
  const totalGrantedCents = appliedGrants.reduce(
    (total, grant) => total + grant.amountCents,
    0,
  );
  const ledgerEvents = [
    ...appliedGrants.map((grant) => ({
      at: grant.appliesAt,
      kind: "grant" as const,
      amountCents: grant.amountCents,
    })),
    ...usageEvents
      .filter((event) => event.createdAt <= asOf)
      .map((event) => ({
        at: event.createdAt,
        kind: "usage" as const,
        event,
      })),
  ].sort((left, right) => {
    const time = left.at.getTime() - right.at.getTime();
    if (time !== 0) return time;
    return left.kind === right.kind ? 0 : left.kind === "grant" ? -1 : 1;
  });
  let usageCostMicros = 0;
  let remainingMicros = 0;
  let chargedUsageEvents = 0;
  let unpricedUsageEvents = 0;

  for (const ledgerEvent of ledgerEvents) {
    if (ledgerEvent.kind === "grant") {
      remainingMicros += centsToMicros(ledgerEvent.amountCents);
      continue;
    }
    if (remainingMicros <= 0) continue;
    const costMicros = usageEventCostMicros(ledgerEvent.event);
    if (costMicros === null) {
      unpricedUsageEvents += 1;
      continue;
    }
    const appliedCostMicros = Math.min(remainingMicros, costMicros);
    if (appliedCostMicros <= 0) continue;
    usageCostMicros += appliedCostMicros;
    remainingMicros -= appliedCostMicros;
    chargedUsageEvents += 1;
  }

  return {
    creditStartsAt,
    totalGrantedCents,
    usageCostMicros,
    remainingMicros,
    chargedUsageEvents,
    unpricedUsageEvents,
  };
}

export function usageEventCostMicros(event: UsageEventForBillingCredits): number | null {
  return (
    event.costMicros ??
    calculateUsageCostMicrosForModel(
      event.modelUsed,
      event.promptTokens,
      event.completionTokens,
    )
  );
}

export function calculateUsageCostMicrosForModel(
  modelUsed: string | null,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (!modelUsed) return null;
  const price = MODEL_PRICES.get(modelUsed);
  if (!price) return null;
  const dollars = promptTokens * price.input + completionTokens * price.output;
  if (dollars <= 0) return 0;
  return Math.ceil(dollars * 1_000_000 - 1e-9);
}

export function centsToMicros(cents: number): number {
  return cents * 10_000;
}

export function formatCurrencyMicros(micros: number): string {
  return (micros / 1_000_000).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: micros % 10_000 === 0 ? 2 : 4,
  });
}

export function parseUsdToCents(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new Error("amount must be a positive USD value with at most two decimals");
  }
  const [dollars, cents = ""] = trimmed.split(".");
  const amountCents = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("amount must be greater than zero");
  }
  return amountCents;
}

export function formatCurrencyCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function earliestAppliesAt(grants: BillingCreditGrantForBalance[]): Date | null {
  let earliest: Date | null = null;
  for (const grant of grants) {
    if (!earliest || grant.appliesAt < earliest) earliest = grant.appliesAt;
  }
  return earliest;
}
