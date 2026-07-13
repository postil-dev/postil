import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest, type NextFetchEvent } from "next/server";

import { middleware } from "@/middleware";

const originalToken = process.env.POSTHOG_PROJECT_TOKEN;
const originalPublicUrl = process.env.POSTIL_PUBLIC_URL;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalToken === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
  else process.env.POSTHOG_PROJECT_TOKEN = originalToken;
  if (originalPublicUrl === undefined) delete process.env.POSTIL_PUBLIC_URL;
  else process.env.POSTIL_PUBLIC_URL = originalPublicUrl;
  globalThis.fetch = originalFetch;
});

describe("server request telemetry privacy", () => {
  test("marks verification pages as private to search crawlers", async () => {
    const event = { waitUntil: () => undefined } as unknown as NextFetchEvent;
    const response = await middleware(
      new NextRequest("https://postil.dev/verify/billing-contact?org=7&token=secret"),
      event,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("does not capture requests carrying DNT or Global Privacy Control", async () => {
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test_project_token";
    let captures = 0;
    const event = {
      waitUntil: () => {
        captures += 1;
      },
    } as unknown as NextFetchEvent;

    await middleware(
      new NextRequest("https://postil.dev/docs", { headers: { "sec-gpc": "1" } }),
      event,
    );
    await middleware(
      new NextRequest("https://postil.dev/docs", { headers: { dnt: "1" } }),
      event,
    );
    await middleware(new NextRequest("https://postil.dev/relay/static/web-vitals.js"), event);

    expect(captures).toBe(0);
  });

  test("bounds the public PostHog ingestion relay", async () => {
    const event = { waitUntil: () => undefined } as unknown as NextFetchEvent;
    const getResponse = await middleware(
      new NextRequest("https://postil.dev/relay/e/", { method: "GET" }),
      event,
    );
    const largeResponse = await middleware(
      new NextRequest("https://postil.dev/relay/i/v0/e/", {
        method: "POST",
        headers: { "content-length": "65537" },
      }),
      event,
    );
    const missingLengthResponse = await middleware(
      new NextRequest("https://postil.dev/relay/e/", { method: "POST" }),
      event,
    );

    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    expect(largeResponse.status).toBe(413);
    expect(missingLengthResponse.status).toBe(411);

    let response = new Response(null, { status: 500 });
    for (let requestNumber = 0; requestNumber <= 1_200; requestNumber += 1) {
      response = await middleware(
        new NextRequest("https://postil.dev/relay/e/", {
          method: "POST",
          headers: {
            "content-length": "100",
            "fly-client-ip": "198.51.100.17",
          },
        }),
        event,
      );
    }
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  test("captures the canonical public URL behind the production proxy", async () => {
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test_project_token";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const captures: Promise<unknown>[] = [];
    const event = {
      waitUntil: (capture: Promise<unknown>) => captures.push(capture),
    } as unknown as NextFetchEvent;

    await middleware(
      new NextRequest("https://localhost:3000/docs?utm_source=release&private=discard", {
        headers: {
          forwarded: "host=evil.example;proto=http",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
        },
      }),
      event,
    );
    await Promise.all(captures);

    expect(requests).toHaveLength(1);
    const payload = (await requests[0]!.json()) as {
      properties: Record<string, unknown>;
    };
    expect(payload.properties.$current_url).toBe(
      "https://postil.dev/docs?utm_source=release",
    );
    expect(payload.properties.$host).toBe("postil.dev");
    expect(payload.properties.$pathname).toBe("/docs");
  });
});
