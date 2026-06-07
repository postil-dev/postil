import { describe, expect, it, vi } from "vitest";

describe("env", () => {
  it("loads with safe defaults in a test environment", async () => {
    const { env } = await import("./env");
    expect(env.NODE_ENV).toBeDefined();
    expect(env.POSTHOG_HOST).toMatch(/^https:\/\/eu\./);
    expect(env.SANDBOX_DRIVER).toBe("fly");
  });

  it("prefers the Trigger runtime API token for dispatch auth", async () => {
    vi.resetModules();
    const originalApiToken = process.env.TRIGGER_API_TOKEN;
    const originalApiKey = process.env.TRIGGER_API_KEY;
    const originalAccessToken = process.env.TRIGGER_ACCESS_TOKEN;
    const originalPat = process.env.TRIGGER_PAT;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    process.env.TRIGGER_API_TOKEN = "test-trigger-api-token";
    process.env.TRIGGER_API_KEY = "test-trigger-api-key";
    process.env.TRIGGER_ACCESS_TOKEN = "test-trigger-access-token";
    process.env.TRIGGER_PAT = "test-trigger-pat";
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    try {
      const { env } = await import("./env");
      expect(env.triggerApiKey).toBe("test-trigger-api-token");
    } finally {
      restore("TRIGGER_API_TOKEN", originalApiToken);
      restore("TRIGGER_API_KEY", originalApiKey);
      restore("TRIGGER_ACCESS_TOKEN", originalAccessToken);
      restore("TRIGGER_PAT", originalPat);
      restore("TRIGGER_SECRET_KEY", originalSecretKey);
    }
  });

  it("falls back through Trigger runtime credential aliases for dispatch auth", async () => {
    vi.resetModules();
    const originalApiToken = process.env.TRIGGER_API_TOKEN;
    const originalApiKey = process.env.TRIGGER_API_KEY;
    const originalAccessToken = process.env.TRIGGER_ACCESS_TOKEN;
    const originalPat = process.env.TRIGGER_PAT;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    delete process.env.TRIGGER_SECRET_KEY;
    delete process.env.TRIGGER_API_KEY;
    process.env.TRIGGER_API_TOKEN = "test-trigger-api-token";
    process.env.TRIGGER_ACCESS_TOKEN = "test-trigger-access-token";
    process.env.TRIGGER_PAT = "test-trigger-pat";
    try {
      const { env } = await import("./env");
      expect(env.triggerApiKey).toBe("test-trigger-api-token");
    } finally {
      restore("TRIGGER_API_TOKEN", originalApiToken);
      restore("TRIGGER_API_KEY", originalApiKey);
      restore("TRIGGER_ACCESS_TOKEN", originalAccessToken);
      restore("TRIGGER_PAT", originalPat);
      restore("TRIGGER_SECRET_KEY", originalSecretKey);
    }
  });

  it("does not use Trigger CLI deploy credentials for dispatch auth", async () => {
    vi.resetModules();
    const originalApiToken = process.env.TRIGGER_API_TOKEN;
    const originalApiKey = process.env.TRIGGER_API_KEY;
    const originalAccessToken = process.env.TRIGGER_ACCESS_TOKEN;
    const originalPat = process.env.TRIGGER_PAT;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    delete process.env.TRIGGER_API_TOKEN;
    delete process.env.TRIGGER_API_KEY;
    delete process.env.TRIGGER_SECRET_KEY;
    process.env.TRIGGER_ACCESS_TOKEN = "test-trigger-access-token";
    process.env.TRIGGER_PAT = "test-trigger-pat";
    try {
      const { env } = await import("./env");
      expect(env.triggerApiKey).toBeUndefined();
    } finally {
      restore("TRIGGER_API_TOKEN", originalApiToken);
      restore("TRIGGER_API_KEY", originalApiKey);
      restore("TRIGGER_ACCESS_TOKEN", originalAccessToken);
      restore("TRIGGER_PAT", originalPat);
      restore("TRIGGER_SECRET_KEY", originalSecretKey);
    }
  });

  it("uses REVIEW_TOKEN_SECRET for review token encryption", async () => {
    vi.resetModules();
    const originalReviewTokenSecret = process.env.REVIEW_TOKEN_SECRET;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    process.env.REVIEW_TOKEN_SECRET = "test-review-token-secret";
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    try {
      const { env } = await import("./env");
      expect(env.reviewTokenSecret).toBe("test-review-token-secret");
      expect(env.triggerApiKey).toBe("test-trigger-secret");
    } finally {
      restore("REVIEW_TOKEN_SECRET", originalReviewTokenSecret);
      restore("TRIGGER_SECRET_KEY", originalSecretKey);
    }
  });

  it("does not use TRIGGER_SECRET_KEY for review token encryption", async () => {
    vi.resetModules();
    const originalReviewTokenSecret = process.env.REVIEW_TOKEN_SECRET;
    const originalSecretKey = process.env.TRIGGER_SECRET_KEY;
    delete process.env.REVIEW_TOKEN_SECRET;
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    try {
      const { env } = await import("./env");
      expect(env.triggerApiKey).toBe("test-trigger-secret");
      expect(env.reviewTokenSecret).toBeUndefined();
    } finally {
      restore("REVIEW_TOKEN_SECRET", originalReviewTokenSecret);
      restore("TRIGGER_SECRET_KEY", originalSecretKey);
    }
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
