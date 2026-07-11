import { afterEach, describe, expect, test } from "bun:test";

import { isTlsError, tlsSelfTest, tlsSelfTestUrl } from "@/worker/tls-selftest";
import "./quiet-console";

/**
 * The boot-time TLS self-test exists to turn a CA-broken image into a failed
 * deploy instead of a worker that silently fails every review. Its contract:
 *
 *  - a TLS/certificate error throws (caller exits non-zero, deploy fails);
 *  - a plain network blip (DNS/refused/timeout) does NOT throw (boot proceeds);
 *  - a successful response does NOT throw.
 *
 * fetch is injected so none of this touches the network.
 */

const origApiBase = process.env.POSTIL_API_BASE;

afterEach(() => {
  if (origApiBase === undefined) delete process.env.POSTIL_API_BASE;
  else process.env.POSTIL_API_BASE = origApiBase;
});

/** A fake fetch that rejects with the given error (or resolves if null). */
function fetchRejecting(err: unknown): typeof fetch {
  return (async () => {
    if (err) throw err;
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

function tlsErr(code: string, message = "TLS handshake failed"): Error {
  return Object.assign(new Error(message), { code });
}

describe("isTlsError", () => {
  test("recognizes OpenSSL/undici trust-store error codes", () => {
    expect(isTlsError(tlsErr("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"))).toBe(true);
    expect(isTlsError(tlsErr("SELF_SIGNED_CERT_IN_CHAIN"))).toBe(true);
    expect(isTlsError(tlsErr("CERT_HAS_EXPIRED"))).toBe(true);
    expect(isTlsError(tlsErr("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe(true);
  });

  test("recognizes a nested cause.code (undici wraps the OpenSSL error)", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: tlsErr("UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
    });
    expect(isTlsError(err)).toBe(true);
  });

  test("recognizes the CA-trust message even without a code", () => {
    expect(isTlsError(new Error("No CA certificates were loaded from the system"))).toBe(true);
    expect(isTlsError(new Error("unable to get local issuer certificate"))).toBe(true);
  });

  test("plain network errors are NOT TLS errors", () => {
    expect(isTlsError(tlsErr("ECONNREFUSED", "connect ECONNREFUSED"))).toBe(false);
    expect(isTlsError(tlsErr("ETIMEDOUT", "request timed out"))).toBe(false);
    expect(isTlsError(tlsErr("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com"))).toBe(false);
    expect(isTlsError(new Error("socket hang up"))).toBe(false);
    expect(isTlsError(undefined)).toBe(false);
  });
});

describe("tlsSelfTestUrl", () => {
  test("uses the configured POSTIL_API_BASE origin", () => {
    process.env.POSTIL_API_BASE = "https://openrouter.ai/api/v1";
    expect(tlsSelfTestUrl()).toBe("https://openrouter.ai");
  });

  test("falls back to the GitHub API when unset", () => {
    delete process.env.POSTIL_API_BASE;
    expect(tlsSelfTestUrl()).toBe("https://api.github.com");
  });

  test("falls back to the GitHub API when the base is unparseable", () => {
    process.env.POSTIL_API_BASE = "not a url";
    expect(tlsSelfTestUrl()).toBe("https://api.github.com");
  });
});

describe("tlsSelfTest (fail-policy)", () => {
  test("a TLS/certificate error is fatal (throws)", async () => {
    await expect(
      tlsSelfTest(fetchRejecting(tlsErr("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"))),
    ).rejects.toThrow(/CA bundle|certificate|TLS/i);
  });

  test("the original CA-missing error is fatal (throws)", async () => {
    await expect(
      tlsSelfTest(fetchRejecting(new Error("No CA certificates were loaded from the system"))),
    ).rejects.toThrow(/cannot start/i);
  });

  test("an undici-wrapped TLS cause is fatal (throws)", async () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: tlsErr("CERT_HAS_EXPIRED"),
    });
    await expect(tlsSelfTest(fetchRejecting(err))).rejects.toThrow(/cannot start/i);
  });

  test("a plain network blip does NOT throw (boot proceeds)", async () => {
    await expect(
      tlsSelfTest(fetchRejecting(tlsErr("ECONNREFUSED", "connect ECONNREFUSED"))),
    ).resolves.toBeUndefined();
    await expect(
      tlsSelfTest(fetchRejecting(tlsErr("ETIMEDOUT", "timed out"))),
    ).resolves.toBeUndefined();
  });

  test("a successful response does NOT throw", async () => {
    await expect(tlsSelfTest(fetchRejecting(null))).resolves.toBeUndefined();
  });

  test("respects the timeout bound (aborts, treated as a non-fatal blip)", async () => {
    // A fetch that honours the abort signal and rejects like a real timeout.
    const slowFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" })),
        );
      })) as unknown as typeof fetch;
    await expect(tlsSelfTest(slowFetch, 10)).resolves.toBeUndefined();
  });
});
