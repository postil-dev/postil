import { describe, expect, it, vi } from "vitest";

describe("env", () => {
  it("loads with safe defaults in a test environment", async () => {
    const { env } = await import("./env");
    expect(env.NODE_ENV).toBeDefined();
    expect(env.POSTHOG_HOST).toMatch(/^https:\/\/eu\./);
    expect(env.SANDBOX_DRIVER).toBe("fly");
  });

  it("uses deployed Trigger secret names as dispatch token fallbacks", async () => {
    vi.resetModules();
    const originalApiToken = process.env.TRIGGER_API_TOKEN;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    process.env.TRIGGER_API_TOKEN = "test-trigger-api-token";
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    try {
      const { env } = await import("./env");
      expect(env.triggerApiKey).toBe("test-trigger-api-token");
    } finally {
      if (originalApiToken === undefined) {
        delete process.env.TRIGGER_API_TOKEN;
      } else {
        process.env.TRIGGER_API_TOKEN = originalApiToken;
      }
      if (originalSecretKey === undefined) {
        delete process.env.TRIGGER_SECRET_KEY;
      } else {
        process.env.TRIGGER_SECRET_KEY = originalSecretKey;
      }
    }
  });
});
