import { expect, test } from "@playwright/test";

test("homepage shows the local-first CLI option", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Install CLI" }).first()).toBeVisible();
});
