import { describe, expect, test } from "bun:test";

import {
  calculateBillingCreditBalance,
  calculateUsageCostMicrosForModel,
  formatCurrencyCents,
  parseUsdToCents,
  usageEventCostMicros,
} from "@/lib/billing-credits";

describe("billing credit calculations", () => {
  test.each([
    ["anthropic/claude-haiku-4.5", 6_000_000],
    ["openai/gpt-5-mini", 2_250_000],
  ] as const)("prices configured scorer %s", (model, expected) => {
    expect(calculateUsageCostMicrosForModel(model, 1_000_000, 1_000_000)).toBe(expected);
  });

  test("snapshots sub-cent usage in USD micros from the model catalog", () => {
    const costMicros = calculateUsageCostMicrosForModel(
      "deepseek/deepseek-v4-pro",
      2_000_000,
      500_000,
    );
    expect(costMicros).toBe(1_305_000);
    expect(
      usageEventCostMicros({
        id: 1,
        promptTokens: 2_000_000,
        completionTokens: 500_000,
        modelUsed: "deepseek/deepseek-v4-pro",
        costMicros,
        createdAt: new Date("2026-07-11T12:00:00.000Z"),
      }),
    ).toBe(1_305_000);
    expect(
      usageEventCostMicros({
        id: 2,
        promptTokens: 2_000_000,
        completionTokens: 500_000,
        modelUsed: "deepseek/deepseek-v4-pro",
        costMicros: null,
        createdAt: new Date("2026-07-11T12:00:00.000Z"),
      }),
    ).toBe(1_305_000);
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
          costMicros: 4_350_000,
          createdAt: new Date("2026-06-30T23:59:00.000Z"),
        },
        {
          id: 2,
          promptTokens: 2_000_000,
          completionTokens: 500_000,
          modelUsed: "deepseek/deepseek-v4-pro",
          costMicros: 1_310_000,
          createdAt: new Date("2026-07-11T12:00:00.000Z"),
        },
        {
          id: 3,
          promptTokens: 1,
          completionTokens: 1,
          modelUsed: "unknown/model",
          costMicros: null,
          createdAt: new Date("2026-07-11T12:01:00.000Z"),
        },
      ],
      { asOf: new Date("2026-07-11T13:00:00.000Z") },
    );

    expect(balance).toEqual({
      creditStartsAt: new Date("2026-07-01T00:00:00.000Z"),
      totalGrantedCents: 20_000,
      usageCostMicros: 1_310_000,
      remainingMicros: 198_690_000,
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
          costMicros: 1_500_000,
          createdAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ],
      { asOf: new Date("2026-07-04T00:00:00.000Z") },
    );

    expect(balance.usageCostMicros).toBe(1_000_000);
    expect(balance.remainingMicros).toBe(1_000_000);
    expect(balance.chargedUsageEvents).toBe(1);
  });

  test("parses and formats USD cents", () => {
    expect(parseUsdToCents("200")).toBe(20_000);
    expect(parseUsdToCents("200.50")).toBe(20_050);
    expect(() => parseUsdToCents("200.500")).toThrow("amount must be a positive USD value");
    expect(formatCurrencyCents(19_869)).toBe("$198.69");
  });
});
