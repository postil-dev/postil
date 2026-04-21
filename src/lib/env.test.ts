import { describe, expect, it } from "vitest";

describe("env", () => {
  it("loads with safe defaults in a test environment", async () => {
    const { env } = await import("./env");
    expect(env.NODE_ENV).toBeDefined();
    expect(env.POSTHOG_HOST).toBe("https://eu.posthog.com");
    expect(env.SANDBOX_DRIVER).toBe("fly");
  });
});
