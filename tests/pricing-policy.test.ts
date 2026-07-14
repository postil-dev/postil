import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
} from "@/lib/pricing-policy";

const root = join(import.meta.dir, "..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("pricing policy", () => {
  test("keeps commercial plan prices in one source of truth", () => {
    expect(HOSTED_ACTIVE_AUTHOR_MONTHLY_USD).toBe(15);
    expect(BYOK_ACTIVE_AUTHOR_MONTHLY_USD).toBe(6);
  });

  test("publishes the billing unit without internal provider-cost metadata", () => {
    const pricing = source("src/app/pricing/page.tsx");
    const terms = source("src/app/terms/page.tsx");
    const settings = source("src/app/orgs/[slug]/settings-form.tsx");

    expect(pricing).toContain("bot or service identity");
    expect(pricing).toContain("Repositories are not billed");
    expect(pricing).toContain("Review volume is not a billing unit");
    expect(terms).toContain("Repository count and review count are not billing units");
    expect(terms).toContain("provider-side budgets and");
    expect(terms).toContain("hard limits where the provider supports them");
    expect(terms).toMatch(/Hosted\s+public-repository reviews are free/);
    expect(settings).toContain("Use only a provider you trust with that code");

    const publicPricingCopy = [pricing, terms, source("src/app/page.tsx")].join("\n");
    expect(publicPricingCopy).not.toMatch(/inference allowance/i);
    expect(publicPricingCopy).not.toMatch(/default overage/i);
  });

  test("structured metadata carries both commercial offers", () => {
    const layout = source("src/app/layout.tsx");
    expect(layout).toContain('name: "Hosted"');
    expect(layout).toContain("price: String(HOSTED_ACTIVE_AUTHOR_MONTHLY_USD)");
    expect(layout).toContain('name: "BYOK"');
    expect(layout).toContain("price: String(BYOK_ACTIVE_AUTHOR_MONTHLY_USD)");
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
    ];
    const combined = files.map(source).join("\n");
    const staleClaims = [
      /Postil.{0,100}\$10/i,
      /\$10.{0,100}Postil/i,
      /unlimited hosted reviews/i,
      /hosted reviews included/i,
      /bill stays independent of PR count/i,
      /price does not scale with PR count/i,
      /inference allowance/i,
      /cost calculator/i,
    ];

    for (const claim of staleClaims) {
      expect(combined).not.toMatch(claim);
    }
  });
});
