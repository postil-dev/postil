import { expect, test } from "@playwright/test";

test("homepage shows the install CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Install on GitHub" }).first()).toBeVisible();
});
