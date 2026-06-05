import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authAssert: vi.fn(() => {
    throw new Error("BETTER_AUTH_SECRET must be set in production.");
  }),
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/auth", () => ({
  assertAuthSecretConfigured: mocks.authAssert,
  auth: {
    handler: {},
  },
}));

vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({
    GET: mocks.get,
    POST: mocks.post,
  }),
}));

const { GET } = await import("./route");

describe("auth route secret checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defers the production secret assertion until the route handler runs", async () => {
    await expect(
      GET(new Request("https://postil.dev/api/auth/get-session"), {
        params: Promise.resolve({ all: ["get-session"] }),
      }),
    ).rejects.toThrow("BETTER_AUTH_SECRET must be set in production.");

    expect(mocks.authAssert).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
