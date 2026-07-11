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
  costCents: number | null;
  createdAt: Date;
}

export interface BillingCreditBalance {
  creditStartsAt: Date | null;
  totalGrantedCents: number;
  usageCostCents: number;
  remainingCents: number;
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
  let usageCostCents = 0;
  let remainingCents = 0;
  let chargedUsageEvents = 0;
  let unpricedUsageEvents = 0;

  for (const ledgerEvent of ledgerEvents) {
    if (ledgerEvent.kind === "grant") {
      remainingCents += ledgerEvent.amountCents;
      continue;
    }
    if (remainingCents <= 0) continue;
    const costCents = usageEventCostCents(ledgerEvent.event);
    if (costCents === null) {
      unpricedUsageEvents += 1;
      continue;
    }
    const appliedCostCents = Math.min(remainingCents, costCents);
    if (appliedCostCents <= 0) continue;
    usageCostCents += appliedCostCents;
    remainingCents -= appliedCostCents;
    chargedUsageEvents += 1;
  }

  return {
    creditStartsAt,
    totalGrantedCents,
    usageCostCents,
    remainingCents,
    chargedUsageEvents,
    unpricedUsageEvents,
  };
}

export function usageEventCostCents(event: UsageEventForBillingCredits): number | null {
  return (
    event.costCents ??
    calculateUsageCostCentsForModel(
      event.modelUsed,
      event.promptTokens,
      event.completionTokens,
    )
  );
}

export function calculateUsageCostCentsForModel(
  modelUsed: string | null,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (!modelUsed) return null;
  const price = MODEL_PRICES.get(modelUsed);
  if (!price) return null;
  const dollars = promptTokens * price.input + completionTokens * price.output;
  if (dollars <= 0) return 0;
  return Math.ceil(dollars * 100 - 1e-9);
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
