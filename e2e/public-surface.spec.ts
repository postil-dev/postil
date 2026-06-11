import { expect, test } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test("homepage example tabs switch on mobile without a scroll jump", async ({ page }) => {
  await page.goto("/");

  const examplesHeading = page.getByRole("heading", { name: "Different risks, same restraint." });
  await examplesHeading.scrollIntoViewIfNeeded();
  const beforeScrollY = await page.evaluate(() => window.scrollY);

  const tablist = page.getByRole("tablist", { name: "Example categories" });
  const billingTab = tablist.getByRole("tab", { name: "Billing" });
  const securityTab = tablist.getByRole("tab", { name: "Security" });
  const uiTab = tablist.getByRole("tab", { name: "UI" });
  const panel = page.getByRole("tabpanel");

  await expect(billingTab).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("heading", { name: "Plan mutation moved before authorization." }),
  ).toBeVisible();

  await billingTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(securityTab).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("heading", { name: "Webhook signature is checked after parsing." }),
  ).toBeVisible();

  await securityTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(uiTab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("heading", { name: "The empty state now hides the primary action." })).toBeVisible();

  const afterScrollY = await page.evaluate(() => window.scrollY);
  expect(Math.abs(afterScrollY - beforeScrollY)).toBeLessThanOrEqual(2);
});

const anchorChecks = [
  {
    path: "/docs",
    heading: "Install the reviewer where pull requests already happen.",
    anchor: "github-action",
    anchorLabel: "GitHub Action",
  },
  {
    path: "/why-postil",
    heading: "Benchmarks and status",
    anchor: "benchmark-method",
    anchorLabel: "Method",
  },
  {
    path: "/how-it-works",
    heading: "A review run you can audit.",
    anchor: "what-the-reviewer-notices",
    anchorLabel: "What the reviewer notices",
  },
  {
    path: "/benchmarks",
    heading: "Methodology first. Claims later.",
    anchor: "methodology",
    anchorLabel: "Methodology",
  },
  {
    path: "/cli",
    heading: "Run Postil in your own CI before the hosted app opens.",
    anchor: "setup",
    anchorLabel: "Setup",
  },
  {
    path: "/security",
    heading: "Report vulnerabilities through the path that reaches a human.",
    anchor: "preferred-report-path",
    anchorLabel: "Preferred report path",
  },
  {
    path: "/brand",
    heading: "Public brand assets and usage notes for Postil.",
    anchor: "downloadable-assets",
    anchorLabel: "Downloadable assets",
  },
  {
    path: "/pricing",
    heading: "Free until billing is real.",
    anchor: "managed-beta",
    anchorLabel: "Managed beta",
  },
  {
    path: "/install",
    heading: "Hosted installs are opening soon.",
    anchor: "hosted",
    anchorLabel: "Hosted",
  },
  {
    path: "/about",
    heading: "About Postil",
    anchor: "maintainer",
    anchorLabel: "Maintainer",
  },
  {
    path: "/privacy",
    heading: "Privacy",
    anchor: "opting-out",
    anchorLabel: "Opting out",
  },
  {
    path: "/contact",
    heading: "Use the channel that matches the kind of issue.",
    anchor: "security",
    anchorLabel: "Security",
  },
  {
    path: "/login",
    heading: "Sign in",
    anchor: "top",
    anchorLabel: "Sign in",
  },
] as const;

for (const check of anchorChecks) {
  test(`public page ${check.path} exposes anchorable route content`, async ({ page }) => {
    await page.goto(check.path);
    await expect(page.getByRole("heading", { name: check.heading })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(`#${check.anchor}`)).toBeVisible();
    await expect(
      page.locator(`a[href="#${check.anchor}"][aria-label="Link to ${check.anchorLabel}"]`),
    ).toHaveCount(1);
  });
}
