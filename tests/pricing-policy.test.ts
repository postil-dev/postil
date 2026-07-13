import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  calculatePostilPricing,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_INFERENCE_ALLOWANCE_USD,
} from "@/lib/pricing-policy";

const root = join(import.meta.dir, "..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("pricing policy", () => {
  test("calculates Hosted and BYOK totals from active authors", () => {
    expect(HOSTED_ACTIVE_AUTHOR_MONTHLY_USD).toBe(15);
    expect(HOSTED_INFERENCE_ALLOWANCE_USD).toBe(6);
    expect(BYOK_ACTIVE_AUTHOR_MONTHLY_USD).toBe(9);
    expect(calculatePostilPricing(20)).toEqual({
      activeAuthors: 20,
      hostedMonthlyUsd: 300,
      hostedInferenceAllowanceUsd: 120,
      byokMonthlyUsd: 180,
    });
  });

  test("normalizes invalid author counts without fractional billing", () => {
    expect(calculatePostilPricing(-1).activeAuthors).toBe(0);
    expect(calculatePostilPricing(3.9).activeAuthors).toBe(3);
  });

  test("publishes the active-author definition and spend safeguards", () => {
    const pricing = source("src/app/pricing/page.tsx");
    const terms = source("src/app/terms/page.tsx");

    expect(pricing).toContain("bot or service identity");
    expect(pricing).toContain("There is no repository charge");
    expect(pricing).toContain("$0 default overage");
    expect(terms).toContain("pooled organization-wide");
    expect(terms).toContain("explicitly choose a higher hard cap");
    expect(terms).toContain("provider-side budgets and");
    expect(terms).toContain("hard limits where the provider supports them");
    expect(terms).toContain("Hosted public-repository reviews are free");
  });

  test("structured metadata carries both commercial offers", () => {
    const layout = source("src/app/layout.tsx");
    expect(layout).toContain('name: "Hosted"');
    expect(layout).toContain('price: "15"');
    expect(layout).toContain('name: "BYOK"');
    expect(layout).toContain('price: "9"');
  });

  test("public Postil copy contains no superseded pricing claims", () => {
    const files = [
      "src/app/page.tsx",
      "src/app/pricing/page.tsx",
      "src/app/why-postil/page.tsx",
      "src/app/vs/coderabbit/page.tsx",
      "src/app/vs/copilot/page.tsx",
      "src/app/vs/greptile/page.tsx",
      "src/app/vs/macroscope/page.tsx",
      "src/app/vs/qodo/page.tsx",
      "src/app/blog/ai-code-review-pricing-2026/page.tsx",
      "src/app/blog/best-ai-code-review-tools-2026/page.tsx",
      "src/components/pricing-calculator.tsx",
    ];
    const combined = files.map(source).join("\n");
    const staleClaims = [
      /Postil.{0,100}\$10/i,
      /\$10.{0,100}Postil/i,
      /unlimited hosted reviews/i,
      /hosted reviews included/i,
      /bill stays independent of PR count/i,
      /price does not scale with PR count/i,
    ];

    for (const claim of staleClaims) {
      expect(combined).not.toMatch(claim);
    }
  });
});
