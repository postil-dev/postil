import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn(() => ({
    api: {},
    handler: {},
  })),
}));

vi.mock("better-auth", () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock("@polar-sh/better-auth", () => ({
  checkout: vi.fn(() => ({})),
  polar: vi.fn(() => ({})),
  portal: vi.fn(() => ({})),
}));

vi.mock("better-auth/plugins", () => ({
  organization: vi.fn(() => ({})),
}));

vi.mock("@/lib/env", () => ({
  env: {
    BETTER_AUTH_SECRET: undefined,
    BETTER_AUTH_URL: "http://localhost:3000",
    GITHUB_APP_CLIENT_ID: undefined,
    GITHUB_APP_CLIENT_SECRET: undefined,
    NODE_ENV: "development",
    POLAR_API_KEY: undefined,
    POLAR_ENVIRONMENT: "sandbox",
  },
}));

const { getAuth } = await import("./index");

describe("getAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("memoizes the auth instance for repeated calls", () => {
    const first = getAuth();
    const second = getAuth();

    expect(first).toBe(second);
    expect(mocks.betterAuth).toHaveBeenCalledTimes(1);
  });
});
