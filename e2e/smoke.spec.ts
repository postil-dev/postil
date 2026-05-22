import { test, expect } from "@playwright/test";

test("health endpoint responds", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body).toEqual({ ok: true, service: "postil-web" });
});

test("homepage loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Postil/);
});

test("about page loads", async ({ page }) => {
  await page.goto("/about");
  await expect(page).toHaveTitle(/Postil/);
});

test("robots endpoint includes crawler exclusions", async ({ request }) => {
  const response = await request.get("/robots.txt");
  expect(response.status()).toBe(200);

  const body = await response.text();
  expect(body).toContain("User-Agent: *");
  expect(body).toContain("User-Agent: GPTBot");
  expect(body).toContain("User-Agent: ClaudeBot");
  expect(body).toContain("User-Agent: Google-Extended");
  expect(body).toContain("User-Agent: PerplexityBot");
  expect(body).toContain("User-Agent: CCBot");
  expect(body).toContain("Disallow: /install");
  expect(body).toContain("Disallow: /login");
  expect(body).toContain("Sitemap: https://postil.dev/sitemap.xml");
});

test("llms endpoint serves concise guidance", async ({ request }) => {
  const response = await request.get("/llms.txt");
  expect(response.status()).toBe(200);

  const body = await response.text();
  expect(body).toContain("# Postil");
  expect(body).toContain("AI pull-request reviewer for GitHub repositories");
  expect(body).toContain("Home: https://postil.dev/");
  expect(body).toContain("Pricing: https://postil.dev/#pricing");
  expect(body).toContain("Repository: https://github.com/postil-dev/postil");
});
