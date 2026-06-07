import { describe, expect, it, vi } from "vitest";

describe("env", () => {
  it("loads with safe defaults in a test environment", async () => {
    const { env } = await import("./env");
    expect(env.NODE_ENV).toBeDefined();
    expect(env.POSTHOG_HOST).toMatch(/^https:\/\/eu\./);
    expect(env.SANDBOX_DRIVER).toBe("fly");
  });

  it("prefers the deployed Trigger secret key for dispatch auth", async () => {
    vi.resetModules();
    const originalApiToken = process.env.TRIGGER_API_TOKEN;
    const originalApiKey = process.env.TRIGGER_API_KEY;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    process.env.TRIGGER_API_TOKEN = "test-trigger-api-token";
    delete process.env.TRIGGER_API_KEY;
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    try {
      const { env } = await import("./env");
      expect(env.triggerApiKey).toBe("test-trigger-secret");
    } finally {
      if (originalApiToken === undefined) {
        delete process.env.TRIGGER_API_TOKEN;
      } else {
        process.env.TRIGGER_API_TOKEN = originalApiToken;
      }
      if (originalApiKey === undefined) {
        delete process.env.TRIGGER_API_KEY;
      } else {
        process.env.TRIGGER_API_KEY = originalApiKey;
      }
      if (originalSecretKey === undefined) {
        delete process.env.TRIGGER_SECRET_KEY;
      } else {
        process.env.TRIGGER_SECRET_KEY = originalSecretKey;
      }
    }
  });

  it("uses REVIEW_TOKEN_SECRET for review token encryption when present", async () => {
    vi.resetModules();
    const originalReviewTokenSecret = process.env.REVIEW_TOKEN_SECRET;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    process.env.REVIEW_TOKEN_SECRET = "test-review-token-secret";
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    try {
      const { env } = await import("./env");
      expect(env.reviewTokenSecret).toBe("test-review-token-secret");
    } finally {
      if (originalReviewTokenSecret === undefined) {
        delete process.env.REVIEW_TOKEN_SECRET;
      } else {
        process.env.REVIEW_TOKEN_SECRET = originalReviewTokenSecret;
      }
      if (originalSecretKey === undefined) {
        delete process.env.TRIGGER_SECRET_KEY;
      } else {
        process.env.TRIGGER_SECRET_KEY = originalSecretKey;
      }
    }
  });

  it("falls back to TRIGGER_SECRET_KEY for review token encryption", async () => {
    vi.resetModules();
    const originalReviewTokenSecret = process.env.REVIEW_TOKEN_SECRET;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    delete process.env.REVIEW_TOKEN_SECRET;
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    try {
      const { env } = await import("./env");
      expect(env.reviewTokenSecret).toBe("test-trigger-secret");
    } finally {
      if (originalReviewTokenSecret === undefined) {
        delete process.env.REVIEW_TOKEN_SECRET;
      } else {
        process.env.REVIEW_TOKEN_SECRET = originalReviewTokenSecret;
      }
      if (originalSecretKey === undefined) {
        delete process.env.TRIGGER_SECRET_KEY;
      } else {
        process.env.TRIGGER_SECRET_KEY = originalSecretKey;
      }
    }
  });

  it("ignores an empty Trigger secret key when a legacy key is present", async () => {
    vi.resetModules();
    const originalApiToken = process.env.TRIGGER_API_TOKEN;
    const originalApiKey = process.env.TRIGGER_API_KEY;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    process.env.TRIGGER_API_TOKEN = "test-trigger-api-token";
    process.env.TRIGGER_API_KEY = "test-trigger-api-key";
    process.env.TRIGGER_SECRET_KEY = "";
    try {
      const { env } = await import("./env");
      expect(env.triggerApiKey).toBe("test-trigger-api-key");
    } finally {
      if (originalApiToken === undefined) {
        delete process.env.TRIGGER_API_TOKEN;
      } else {
        process.env.TRIGGER_API_TOKEN = originalApiToken;
      }
      if (originalApiKey === undefined) {
        delete process.env.TRIGGER_API_KEY;
      } else {
        process.env.TRIGGER_API_KEY = originalApiKey;
      }
      if (originalSecretKey === undefined) {
        delete process.env.TRIGGER_SECRET_KEY;
      } else {
        process.env.TRIGGER_SECRET_KEY = originalSecretKey;
      }
    }
  });
});
