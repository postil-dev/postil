import { expect, test } from "@playwright/test";

test("admin reviews redirects unauthenticated visitors to sign in", async ({ page }) => {
  await page.goto("/admin/reviews");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Freviews/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
