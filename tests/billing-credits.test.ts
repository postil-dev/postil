import { describe, expect, test } from "bun:test";

import {
  calculateBillingCreditBalance,
  calculateUsageCostCentsForModel,
  formatCurrencyCents,
  parseUsdToCents,
  usageEventCostCents,
} from "@/lib/billing-credits";

describe("billing credit calculations", () => {
  test("snapshots usage events in whole cents from the model catalog", () => {
    const costCents = calculateUsageCostCentsForModel(
      "deepseek/deepseek-v4-pro",
      2_000_000,
      500_000,
    );
    expect(costCents).toBe(131);
    expect(
      usageEventCostCents({
        id: 1,
        promptTokens: 2_000_000,
        completionTokens: 500_000,
        modelUsed: "deepseek/deepseek-v4-pro",
        costCents,
        createdAt: new Date("2026-07-11T12:00:00.000Z"),
      }),
    ).toBe(131);
    expect(
      usageEventCostCents({
        id: 2,
        promptTokens: 2_000_000,
        completionTokens: 500_000,
        modelUsed: "deepseek/deepseek-v4-pro",
        costCents: null,
        createdAt: new Date("2026-07-11T12:00:00.000Z"),
      }),
    ).toBe(131);
  });

  test("deducts post-grant usage from applied credit grants", () => {
    const balance = calculateBillingCreditBalance(
      [
        {
          amountCents: 20_000,
          appliesAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          amountCents: 10_000,
          appliesAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
      [
        {
          id: 1,
          promptTokens: 10_000_000,
          completionTokens: 0,
          modelUsed: "deepseek/deepseek-v4-pro",
          costCents: 435,
          createdAt: new Date("2026-06-30T23:59:00.000Z"),
        },
        {
          id: 2,
          promptTokens: 2_000_000,
          completionTokens: 500_000,
          modelUsed: "deepseek/deepseek-v4-pro",
          costCents: 131,
          createdAt: new Date("2026-07-11T12:00:00.000Z"),
        },
        {
          id: 3,
          promptTokens: 1,
          completionTokens: 1,
          modelUsed: "unknown/model",
          costCents: null,
          createdAt: new Date("2026-07-11T12:01:00.000Z"),
        },
      ],
      { asOf: new Date("2026-07-11T13:00:00.000Z") },
    );

    expect(balance).toEqual({
      creditStartsAt: new Date("2026-07-01T00:00:00.000Z"),
      totalGrantedCents: 20_000,
      usageCostCents: 131,
      remainingCents: 19_869,
      chargedUsageEvents: 1,
      unpricedUsageEvents: 1,
    });
  });

  test("does not spend later grants on earlier usage", () => {
    const balance = calculateBillingCreditBalance(
      [
        { amountCents: 100, appliesAt: new Date("2026-07-01T00:00:00.000Z") },
        { amountCents: 100, appliesAt: new Date("2026-07-03T00:00:00.000Z") },
      ],
      [
        {
          id: 1,
          promptTokens: 0,
          completionTokens: 0,
          modelUsed: "test/model",
          costCents: 150,
          createdAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ],
      { asOf: new Date("2026-07-04T00:00:00.000Z") },
    );

    expect(balance.usageCostCents).toBe(100);
    expect(balance.remainingCents).toBe(100);
    expect(balance.chargedUsageEvents).toBe(1);
  });

  test("parses and formats USD cents", () => {
    expect(parseUsdToCents("200")).toBe(20_000);
    expect(parseUsdToCents("200.50")).toBe(20_050);
    expect(() => parseUsdToCents("200.500")).toThrow("amount must be a positive USD value");
    expect(formatCurrencyCents(19_869)).toBe("$198.69");
  });
});
