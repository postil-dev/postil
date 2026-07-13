import { afterEach, describe, expect, test } from "bun:test";

const OLD_ENV = { ...process.env };
const route = await import("@/app/api/analytics/posthog/route");

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in OLD_ENV)) delete process.env[key];
  }
  Object.assign(process.env, OLD_ENV);
});

describe("/api/analytics/posthog", () => {
  test("returns 204 when PostHog is not configured", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.POSTHOG_PROJECT_TOKEN;

    const response = await route.GET(request());

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("returns the public project config from runtime env", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test_project_token";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";

    const response = await route.GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      key: "phc_test_project_token",
      apiHost: "/relay",
      uiHost: "https://eu.posthog.com",
    });
  });

  test("returns 204 when POSTHOG_CLIENT_CAPTURE is 0, even with a key configured", async () => {
    process.env.POSTHOG_CLIENT_CAPTURE = "0";
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_project_token";

    const response = await route.GET(request());

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("honors Global Privacy Control and Do Not Track", async () => {
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test_project_token";

    const gpc = await route.GET(
      new Request("https://postil.dev/api/analytics/posthog", {
        headers: { "sec-gpc": "1" },
      }),
    );
    const dnt = await route.GET(
      new Request("https://postil.dev/api/analytics/posthog", {
        headers: { dnt: "1" },
      }),
    );

    expect(gpc.status).toBe(204);
    expect(dnt.status).toBe(204);
  });
});

function request(): Request {
  return new Request("https://postil.dev/api/analytics/posthog");
}
