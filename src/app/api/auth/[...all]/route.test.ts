import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

function restoreEnv() {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;

  if (ORIGINAL_BETTER_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_BETTER_AUTH_SECRET;
}

describe("auth route secret checks", () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it("defers the production secret assertion until the route handler runs", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    delete process.env.BETTER_AUTH_SECRET;

    const route = await import("./route");

    await expect(
      route.GET(new Request("https://postil.dev/api/auth/get-session"), {
        params: Promise.resolve({ all: ["get-session"] }),
      }),
    ).rejects.toThrow("BETTER_AUTH_SECRET must be set in production.");
  });
});
