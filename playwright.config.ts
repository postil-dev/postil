import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const basePort = new URL(baseURL).port || "3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: process.env.CI
      ? [
          'rm -rf /tmp/postil-playwright-standalone',
          'mkdir -p /tmp/postil-playwright-standalone/.next',
          'cp -R .next/standalone/. /tmp/postil-playwright-standalone/',
          'cp -R .next/static /tmp/postil-playwright-standalone/.next/static',
          'cp -R public /tmp/postil-playwright-standalone/public',
          `cd /tmp/postil-playwright-standalone && HOSTNAME=0.0.0.0 PORT=${basePort} bun server.js`,
        ].join(" && ")
      : "bun run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
