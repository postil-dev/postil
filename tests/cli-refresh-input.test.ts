import { describe, expect, test } from "bun:test";

import {
  CLI_JSON_BODY_MAX_BYTES,
  isCliRefreshToken,
  readCliJsonBody,
} from "@/lib/cli-auth";

describe("CLI refresh credential input", () => {
  test("accepts only the opaque refresh-token shape", () => {
    expect(isCliRefreshToken(`pclr_${"a".repeat(43)}`)).toBe(true);
    expect(isCliRefreshToken(`pcli_${"a".repeat(43)}`)).toBe(false);
    expect(isCliRefreshToken(`pclr_${"a".repeat(42)}`)).toBe(false);
    expect(isCliRefreshToken("pclr_not-a-token")).toBe(false);
  });

  test("rejects malformed JSON and malformed Content-Length", async () => {
    const malformed = await readCliJsonBody(
      new Request("https://postil.dev/api/cli/token/refresh", {
        method: "POST",
        body: "{",
      }),
    );
    expect(malformed).toEqual({ ok: false, status: 400 });

    const malformedLength = await readCliJsonBody(
      new Request("https://postil.dev/api/cli/token/refresh", {
        method: "POST",
        headers: { "content-length": "not-a-length" },
        body: "{}",
      }),
    );
    expect(malformedLength).toEqual({ ok: false, status: 400 });
  });

  test("rejects declared and streamed bodies above the credential limit", async () => {
    const declared = await readCliJsonBody(
      new Request("https://postil.dev/api/cli/token/refresh", {
        method: "POST",
        headers: { "content-length": String(CLI_JSON_BODY_MAX_BYTES + 1) },
        body: "{}",
      }),
    );
    expect(declared).toEqual({ ok: false, status: 413 });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("x".repeat(CLI_JSON_BODY_MAX_BYTES + 1)),
        );
        controller.close();
      },
    });
    const streamed = await readCliJsonBody(
      new Request("https://postil.dev/api/cli/token/refresh", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(streamed).toEqual({ ok: false, status: 413 });
  });

  test("preserves an empty logout body for legacy authorization-only clients", async () => {
    const result = await readCliJsonBody(
      new Request("https://postil.dev/api/cli/logout", { method: "POST" }),
    );
    expect(result).toEqual({ ok: true, body: null });
  });
});
