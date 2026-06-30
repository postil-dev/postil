import { describe, expect, test } from "bun:test";

import {
  isPublicTelemetryPath,
  publicTelemetryProperties,
  sanitizedPublicUrl,
  sanitizedReferrer,
} from "@/lib/telemetry";

describe("public telemetry sanitization", () => {
  test("allows public marketing, docs, and comparison paths", () => {
    expect(isPublicTelemetryPath("/")).toBe(true);
    expect(isPublicTelemetryPath("/docs/self-hosted")).toBe(true);
    expect(isPublicTelemetryPath("/blog/best-ai-code-review-tools-2026")).toBe(true);
    expect(isPublicTelemetryPath("/vs/copilot")).toBe(true);
  });

  test("does not capture protected dashboard paths", () => {
    expect(isPublicTelemetryPath("/reports")).toBe(false);
    expect(isPublicTelemetryPath("/orgs/postil")).toBe(false);
    expect(publicTelemetryProperties("https://postil.dev/reports?token=abc")).toBeUndefined();
  });

  test("keeps campaign query params and drops arbitrary query params", () => {
    expect(
      sanitizedPublicUrl(
        "https://postil.dev/docs?utm_source=hn&secret=keep-out&ref=launch#section",
      ),
    ).toBe("https://postil.dev/docs?utm_source=hn&ref=launch");
  });

  test("sanitizes referrers without leaking arbitrary query strings", () => {
    expect(
      sanitizedReferrer(
        "https://google.com/search?q=private+query&utm_campaign=launch",
        "https://postil.dev",
      ),
    ).toBe("https://google.com/?utm_campaign=launch");
    expect(
      sanitizedReferrer(
        "https://postil.dev/docs/self-hosted?x=secret&utm_source=docs",
        "https://postil.dev",
      ),
    ).toBe("https://postil.dev/docs/self-hosted?utm_source=docs");
    expect(sanitizedReferrer("https://postil.dev/orgs/private?x=secret", "https://postil.dev")).toBe(
      "https://postil.dev/",
    );
  });
});
