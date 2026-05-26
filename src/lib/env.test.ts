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
    const original = process.env.TRIGGER_SECRET_KEY;
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    try {
      const { env } = await import("./env");
      expect(env.triggerApiKey).toBe("test-trigger-secret");
    } finally {
      if (original === undefined) {
        delete process.env.TRIGGER_SECRET_KEY;
      } else {
        process.env.TRIGGER_SECRET_KEY = original;
      }
    }
  });
});
