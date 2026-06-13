import { describe, expect, test } from "bun:test";

import { isPermanentFailure } from "@/worker/failure-classifier";

/**
 * The classifier decides whether a job failure is deterministic (fail fast,
 * skip the remaining attempts) or transient (retry with backoff). It must be
 * conservative: a wrong "permanent" verdict suppresses retries a genuinely
 * transient failure needs, which is worse than one extra retry on a
 * deterministic one. So permanent is true only for unambiguous image/payload/
 * config defects, and any transient signature in the message wins.
 */

describe("isPermanentFailure — permanent (deterministic) signatures", () => {
  test("the original CA-trust incident, as the CLI surfaced it", () => {
    // Exact shape from the ops audit: stderr embedded in the thrown message.
    expect(
      isPermanentFailure(
        "postil CLI exited with code 2: postil: error: builder error: " +
          "unexpected error: No CA certificates were loaded from the system",
      ),
    ).toBe(true);
  });

  test("other CA / TLS trust-store breakages", () => {
    expect(isPermanentFailure("ca certificates missing")).toBe(true);
    expect(isPermanentFailure("could not load CA bundle")).toBe(true);
    expect(isPermanentFailure("unable to get local issuer certificate")).toBe(true);
    expect(isPermanentFailure("self-signed certificate in certificate chain")).toBe(true);
    expect(isPermanentFailure("x509: certificate signed by unknown authority")).toBe(true);
  });

  test("missing or non-executable CLI binary", () => {
    expect(isPermanentFailure("CLI not found")).toBe(true);
    expect(
      isPermanentFailure("failed to spawn postil CLI (postil): ENOENT. Set POSTIL_BIN"),
    ).toBe(true);
    expect(isPermanentFailure("spawn postil EACCES")).toBe(true);
    expect(isPermanentFailure("postil CLI not found or not executable at 'postil'")).toBe(true);
  });

  test("build / module-loader defects baked into the image", () => {
    expect(isPermanentFailure("builder error: unexpected error")).toBe(true);
    expect(isPermanentFailure("loader error: bad bytecode")).toBe(true);
    expect(isPermanentFailure("Cannot find module '@/lib/foo'")).toBe(true);
    expect(isPermanentFailure("Error: Module not found")).toBe(true);
  });

  test("malformed payload", () => {
    expect(
      isPermanentFailure('respond job payload malformed: ["installationId","comment"]'),
    ).toBe(true);
    expect(isPermanentFailure("malformed payload")).toBe(true);
  });

  test("unsupported / unknown forge and unknown job kind", () => {
    expect(isPermanentFailure("unsupported forge: bitbucket")).toBe(true);
    expect(isPermanentFailure("unknown forge")).toBe(true);
    expect(isPermanentFailure("unknown job kind: frobnicate")).toBe(true);
  });
});

describe("isPermanentFailure — transient classes stay retryable", () => {
  test("provider 5xx", () => {
    expect(isPermanentFailure("postil CLI exited with code 2: upstream returned 500")).toBe(false);
    expect(isPermanentFailure("HTTP 502 Bad Gateway")).toBe(false);
    expect(isPermanentFailure("503 Service Unavailable")).toBe(false);
    expect(isPermanentFailure("504 Gateway Timeout")).toBe(false);
  });

  test("rate limiting / 429 / overload", () => {
    expect(isPermanentFailure("429 Too Many Requests")).toBe(false);
    expect(isPermanentFailure("rate limit exceeded")).toBe(false);
    expect(isPermanentFailure("the model is overloaded, retry later")).toBe(false);
  });

  test("timeouts and deadlines", () => {
    expect(isPermanentFailure("review exceeded 10 minute deadline")).toBe(false);
    expect(isPermanentFailure("respond exceeded the CLI deadline")).toBe(false);
    expect(isPermanentFailure("request timed out")).toBe(false);
    expect(isPermanentFailure("ETIMEDOUT")).toBe(false);
  });

  test("network / socket errors", () => {
    expect(isPermanentFailure("read ECONNRESET")).toBe(false);
    expect(isPermanentFailure("connect ECONNREFUSED 1.2.3.4:443")).toBe(false);
    expect(isPermanentFailure("socket hang up")).toBe(false);
    expect(isPermanentFailure("getaddrinfo EAI_AGAIN api.example.com")).toBe(false);
    expect(isPermanentFailure("network error: connection reset")).toBe(false);
  });

  test("empty / unknown messages default to transient", () => {
    expect(isPermanentFailure("")).toBe(false);
    expect(isPermanentFailure("something unexpected happened")).toBe(false);
    expect(isPermanentFailure("postil CLI exited with code 2: ")).toBe(false);
  });
});

describe("isPermanentFailure — transient wins ties (conservative)", () => {
  test("a 503 whose body mentions a certificate is still transient", () => {
    // A permanent-looking token must not flip a clearly transient failure.
    expect(
      isPermanentFailure("503 Service Unavailable: certificate authority is updating"),
    ).toBe(false);
  });

  test("a timeout that also says ENOENT in the body is still transient", () => {
    expect(isPermanentFailure("request timed out (downstream ENOENT)")).toBe(false);
  });
});
