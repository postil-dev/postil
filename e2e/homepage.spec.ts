import { expect, test } from "@playwright/test";

test("homepage shows the self-host pricing option", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Self-host" })).toBeVisible();
});
