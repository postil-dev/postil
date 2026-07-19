import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { middleware } from "@/middleware";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("middleware telemetry boundary", () => {
  test("marks verification pages as private to search crawlers", async () => {
    const response = await middleware(
      new NextRequest("https://postil.dev/verify/billing-contact?org=7&token=secret"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("does not send request telemetry or proxy PostHog ingestion", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const publicResponse = await middleware(
      new NextRequest("https://postil.dev/docs?utm_source=release&gclid=click-id", {
        headers: {
          "user-agent": "hostile-user-agent",
          "cf-ray": "high-cardinality-request-id",
          "cf-ipcountry": "GB",
        },
      }),
    );
    const retiredRelayResponse = await middleware(
      new NextRequest("https://postil.dev/relay/e/", {
        method: "POST",
        headers: { "content-length": "100" },
      }),
    );

    expect(publicResponse.status).toBe(200);
    expect(retiredRelayResponse.status).toBe(200);
    expect(requests).toBe(0);
  });
});
