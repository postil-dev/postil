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
    expect(pricing).toMatch(/Repositories are\s+not billed/);
    expect(pricing).toContain("Review volume is not a billing unit");
    expect(terms).toContain("Repository count and review count are not billing units");
    expect(terms).toContain("provider-side budgets and");
    expect(terms).toContain("hard limits where the provider supports them");
    expect(pricing).toMatch(/Public repositories\s+are free with your provider/);
    expect(pricing).toContain("30-day free trial");
    expect(pricing).toContain('href="/contact"');
    expect(pricing).toContain("Install with BYOK");
    expect(pricing).toContain("Start 30-day trial");
    expect(terms).toContain("Public-repository App reviews are free");
    expect(terms).toContain("materially beyond ordinary interactive");
    expect(terms).not.toContain("Where practicable");
    expect(settings).toContain("Use only a provider you trust with that code");

    const publicPricingCopy = [pricing, terms, source("src/app/page.tsx")].join("\n");
    expect(publicPricingCopy).not.toMatch(/inference allowance/i);
    expect(publicPricingCopy).not.toMatch(/default overage/i);
  });

  test("presents BYOK as the primary available commercial path", () => {
    const pricing = source("src/app/pricing/page.tsx");
    const homepage = source("src/app/page.tsx");
    const byok = pricing.indexOf('<h2 className="eyebrow">BYOK</h2>');
    const hosted = pricing.indexOf('<h2 className="eyebrow">Hosted</h2>');

    expect(byok).toBeGreaterThan(0);
    expect(hosted).toBeGreaterThan(byok);
    expect(pricing.slice(byok, hosted)).toContain("btn-primary");
    expect(pricing.slice(byok, hosted)).toContain('href="/install"');
    expect(pricing.slice(hosted)).toContain("btn-secondary");
    const pricingSection = homepage.slice(homepage.indexOf("{/* 07 - Pricing teaser */}"));
    expect(pricingSection).toContain("md:grid-cols-2 xl:grid-cols-4");
    expect(homepage.indexOf("BYOK ${BYOK_ACTIVE_AUTHOR_MONTHLY_USD}")).toBeLessThan(
      homepage.indexOf("Hosted ${HOSTED_ACTIVE_AUTHOR_MONTHLY_USD}"),
    );
  });

  test("structured metadata advertises the available self-service offer", () => {
    const layout = source("src/app/layout.tsx");
    expect(layout).not.toContain('name: "Hosted"');
    expect(layout).toContain('name: "BYOK"');
    expect(layout).toContain("price: String(BYOK_ACTIVE_AUTHOR_MONTHLY_USD)");
  });

  test("keeps public setup surfaces self-service with a BYOK trial", () => {
    const setupCopy = [
      source("src/app/install/page.tsx"),
      source("src/app/docs/page.tsx"),
      source("src/app/docs/quickstart/page.tsx"),
      source("src/components/forge-install-tabs.tsx"),
      source("src/components/site-footer.tsx"),
    ].join("\n");
    const settings = source("src/app/orgs/[slug]/settings-form.tsx");
    const privacy = source("src/app/privacy/page.tsx");
    const billing = source("src/app/orgs/[slug]/billing/page.tsx");

    expect(setupCopy).toContain("GitHub App");
    expect(setupCopy).toContain("30-day free trial");
    expect(setupCopy).not.toMatch(/zero.configuration/i);
    expect(setupCopy).not.toContain("Postil&apos;s hosted default model");
    expect(settings).toContain("!hostedInferenceAvailable");
    expect(setupCopy).toContain("model provider");
    expect(settings).toContain("New hosted inference setup is unavailable");
    expect(privacy).toContain("Existing hosted plans use");
    expect(billing).not.toMatch(/included usage|overage hard cap|credit balance|credit grants/i);
    expect(billing).not.toContain("calculateBillingCreditBalance");
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
      /with the calculator/i,
    ];

    for (const claim of staleClaims) {
      expect(combined).not.toMatch(claim);
    }
  });
});
