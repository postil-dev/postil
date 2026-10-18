import { describe, expect, test } from "bun:test";

import {
  readBoundedWebhookBody,
  signWebhookBody,
  verifyWebhookSignature,
} from "@/lib/crypto/webhook";

const SECRET = "test-webhook-secret";

describe("webhook signature verification", () => {
  test("accepts a correctly signed body", () => {
    const body = JSON.stringify({ action: "opened", number: 7 });
    const header = signWebhookBody(body, SECRET);
    expect(header.startsWith("sha256=")).toBe(true);
    expect(verifyWebhookSignature(body, header, SECRET)).toBe(true);
  });

  test("rejects a tampered body", () => {
    const body = JSON.stringify({ action: "opened", number: 7 });
    const header = signWebhookBody(body, SECRET);
    const tampered = JSON.stringify({ action: "opened", number: 8 });
    expect(verifyWebhookSignature(tampered, header, SECRET)).toBe(false);
  });

  test("rejects a signature made with the wrong secret", () => {
    const body = "payload";
    const header = signWebhookBody(body, "other-secret");
    expect(verifyWebhookSignature(body, header, SECRET)).toBe(false);
  });

  test("rejects missing, malformed, and wrong-length headers", () => {
    const body = "payload";
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=abcdef", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=deadbeef", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=not-hex-at-all-but-right-length-0000000000000000000000000000000000", SECRET)).toBe(false);
  });

  test("verifies against the raw bytes, not parsed JSON", () => {
    // Same JSON value, different raw encoding: signature must not transfer.
    const compact = '{"a":1}';
    const spaced = '{ "a": 1 }';
    const header = signWebhookBody(compact, SECRET);
    expect(verifyWebhookSignature(spaced, header, SECRET)).toBe(false);
  });

  test("rejects an oversized declared body before reading it", async () => {
    const request = new Request("https://postil.dev/api/webhooks/github", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "9" },
    });

    expect(await readBoundedWebhookBody(request, 8)).toEqual({ ok: false, status: 413 });
    expect(request.bodyUsed).toBe(false);
  });

  test("bounds streamed bodies when Content-Length is absent or understated", async () => {
    const absent = new Request("https://postil.dev/api/webhooks/github", {
      method: "POST",
      body: "123456789",
    });
    const understated = new Request("https://postil.dev/api/webhooks/github", {
      method: "POST",
      body: "123456789",
      headers: { "content-length": "4" },
    });

    expect(await readBoundedWebhookBody(absent, 8)).toEqual({ ok: false, status: 413 });
    expect(await readBoundedWebhookBody(understated, 8)).toEqual({ ok: false, status: 413 });
  });

  test("returns the exact signed bytes inside the bound", async () => {
    const body = Buffer.from('{"message":"héllo"}', "utf8");
    const request = new Request("https://postil.dev/api/webhooks/github", {
      method: "POST",
      body,
    });
    const result = await readBoundedWebhookBody(request, body.byteLength);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a bounded body");
    expect(result.body.equals(body)).toBe(true);
    expect(verifyWebhookSignature(result.body, signWebhookBody(body, SECRET), SECRET)).toBe(true);
  });

  test("rejects excess bytes before pending cancellation completes", async () => {
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<null>();
    let cancels = 0;
    const request = new Request("https://example.test/webhook", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(crypto.getRandomValues(new Uint8Array(9))); },
        cancel() { cancels++; entered.resolve(); return cleanup.promise; },
      }),
    });
    const result = readBoundedWebhookBody(request, 8);
    const timer = setTimeout(() => deadline.resolve(null), 250);
    try {
      await Promise.race([entered.promise, deadline.promise]);
      expect(cancels).toBe(1);
      expect(await Promise.race([result, deadline.promise])).toEqual({ ok: false, status: 413 });
      expect(request.body!.locked).toBe(false);
    } finally {
      clearTimeout(timer);
      cleanup.resolve();
      await result;
    }
  });

  test("preserves excess-byte rejection when cancellation rejects immediately or later", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const late of [false, true]) {
        const cleanup = Promise.withResolvers<void>();
        const deadline = Promise.withResolvers<null>();
        const failure = new Error(crypto.randomUUID());
        let cancels = 0;
        const request = new Request("https://example.test/webhook", {
          method: "POST",
          body: new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(crypto.getRandomValues(new Uint8Array(9))); },
            cancel() { cancels++; return late ? cleanup.promise : Promise.reject(failure); },
          }),
        });
        const result = readBoundedWebhookBody(request, 8);
        const timer = setTimeout(() => deadline.resolve(null), 250);
        try {
          expect(await Promise.race([result, deadline.promise])).toEqual({ ok: false, status: 413 });
          expect(cancels).toBe(1);
          expect(request.body!.locked).toBe(false);
          if (late) cleanup.reject(failure);
        } finally {
          clearTimeout(timer);
          cleanup.resolve();
          await result;
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(unhandled).toEqual([]);
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
