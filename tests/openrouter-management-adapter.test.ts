import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  OPENROUTER_EXACT_LIMIT_MAX_MICROS,
  OPENROUTER_KEY_NAME_MAX_LENGTH,
  OPENROUTER_PROVIDER_BINDING,
  OpenRouterManagementAdapterError,
  createOpenRouterManagementAdapter,
  exactOpenRouterLimitMicros,
  type OpenRouterManagementRequest,
  type OpenRouterManagementTransport,
} from "@/lib/openrouter-management-adapter";

const MANAGEMENT_CREDENTIAL = "management-credential-for-tests";
const CREATE_INTENT_ID = "018f47a2-8f3c-4d56-8a90-123456789abc";
const EXPIRES_AT = new Date("2026-09-01T00:00:00.000Z");
const EXPIRES_AT_ISO = EXPIRES_AT.toISOString();

function key(input: {
  hash: string;
  name: string;
  disabled?: boolean;
  limit?: number;
  expiresAt?: string | null;
  limitReset?: "daily" | "weekly" | "monthly" | null;
}) {
  return {
    hash: input.hash,
    name: input.name,
    disabled: input.disabled ?? false,
    limit: input.limit ?? 1,
    expires_at: input.expiresAt ?? EXPIRES_AT_ISO,
    limit_reset: input.limitReset ?? null,
  };
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function responseAt(
  response: Response,
  url: string,
  redirected = false,
): Response {
  Object.defineProperties(response, {
    url: { value: url },
    redirected: { value: redirected },
  });
  return response;
}

function adapter(
  transport: OpenRouterManagementTransport,
  limits: {
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
    maxPages?: number;
  } = {},
) {
  return createOpenRouterManagementAdapter({
    managementCredential: MANAGEMENT_CREDENTIAL,
    transport: async (request) => {
      const response = await transport(request);
      return response.url === "" ? responseAt(response, request.url) : response;
    },
    limits,
  });
}

function mutationAdapter(
  transport: OpenRouterManagementTransport,
  limits: {
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
    maxPages?: number;
  } = {},
) {
  return adapter(
    async (request) =>
      request.method === "GET" ? json({ data: [] }) : transport(request),
    limits,
  );
}

const micros = exactOpenRouterLimitMicros;

describe("OpenRouter management adapter", () => {
  test("binds every request to OpenRouter and exposes only dark management operations", async () => {
    const requests: OpenRouterManagementRequest[] = [];
    const client = adapter(async (request) => {
      requests.push(request);
        return json({ data: [] });
      });

      await client.findKeysByExactName("opaque org key");

      expect(client.binding).toBe(OPENROUTER_PROVIDER_BINDING);
      expect(Object.keys(client).sort()).toEqual([
        "binding",
        "createKeyAfterPersistedIntent",
        "disableKey",
        "findKeyByHash",
        "findKeysByExactName",
      ]);
      expect("deleteKey" in client).toBe(false);
      expect("inferenceKey" in client).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.binding).toBe(OPENROUTER_PROVIDER_BINDING);
      expect(requests[0]?.url).toBe(
        "https://openrouter.ai/api/v1/keys?include_disabled=true&offset=0",
      );
      expect(requests[0]?.redirect).toBe("error");
      expect(Object.isFrozen(requests[0])).toBe(true);
      expect(Object.isFrozen(requests[0]?.headers)).toBe(true);
      expect(() => {
        (requests[0] as { url: string }).url = "https://example.invalid";
      }).toThrow();
      expect(requests[0]?.headers).toEqual({
      authorization: `Bearer ${MANAGEMENT_CREDENTIAL}`,
      accept: "application/json",
    });
  });

  test("distinguishes zero, one, and multiple exact opaque-name matches", async () => {
    const listed = [
      key({ hash: "hash-none", name: "postil-org-42-suffix" }),
      key({ hash: "hash-one", name: "postil-org-42" }),
      key({ hash: "hash-two", name: "postil-org-42" }),
      key({ hash: "hash-case", name: "POSTIL-ORG-42" }),
    ];
    const client = adapter(async (request) => {
      const url = new URL(request.url);
      const hash = url.pathname.match(/\/keys\/(.+)$/)?.[1];
      if (hash) {
        const match = listed.find((candidate) => candidate.hash === hash);
        return match
          ? json({ data: match })
          : json({ error: "missing" }, 404);
      }
      return json({
        data: url.searchParams.get("offset") === "0" ? listed : [],
      });
    });

    await expect(client.findKeysByExactName("missing")).resolves.toEqual({
      status: "none",
      binding: OPENROUTER_PROVIDER_BINDING,
      name: "missing",
      matches: [],
    });
    await expect(
      client.findKeysByExactName("postil-org-42-suffix"),
    ).resolves.toMatchObject({
      status: "one",
      matches: [{ hash: "hash-none", name: "postil-org-42-suffix" }],
    });
    await expect(
      client.findKeysByExactName("postil-org-42"),
    ).resolves.toMatchObject({
      status: "multiple",
      matches: [
        { hash: "hash-one", name: "postil-org-42" },
        { hash: "hash-two", name: "postil-org-42" },
      ],
    });
    await expect(client.findKeyByHash("hash-one")).resolves.toMatchObject({
      status: "present",
      hash: "hash-one",
      key: { name: "postil-org-42", disabled: false },
    });
    await expect(client.findKeyByHash("missing-hash")).resolves.toEqual({
      status: "absent",
      binding: OPENROUTER_PROVIDER_BINDING,
      hash: "missing-hash",
      key: null,
    });
  });

  test("rejects redirects and any final destination outside the exact request", async () => {
    const wrongDestination = adapter(async (request) =>
      responseAt(
        json({ data: [] }),
        request.url.replace("openrouter.ai", "example.invalid"),
      ),
    );
    const redirected = adapter(async (request) =>
      responseAt(json({ data: [] }), request.url, true),
    );

    await expect(
      wrongDestination.findKeysByExactName("target"),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(
      redirected.findKeysByExactName("target"),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  test("paginates by returned length until an explicit empty page", async () => {
    const offsets: string[] = [];
    const pages = [
      [
        key({ hash: "hash-a", name: "target" }),
        key({ hash: "hash-b", name: "other" }),
      ],
      [
        key({ hash: "hash-c", name: "target" }),
        key({ hash: "hash-d", name: "other-two" }),
      ],
      [key({ hash: "hash-e", name: "last" })],
      [],
    ];
    const client = adapter(
      async (request) => {
        offsets.push(new URL(request.url).searchParams.get("offset")!);
        return json({ data: pages[offsets.length - 1] });
      },
      { maxPages: 4 },
    );

    const result = await client.findKeysByExactName("target");

    expect(result.status).toBe("multiple");
    expect(offsets).toEqual(["0", "2", "4", "5"]);
  });

  test("continues after a short page and finds a target at its exact next offset", async () => {
    const offsets: string[] = [];
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      key({ hash: `first-${index}`, name: `other-${index}` }),
    );
    const client = adapter(async (request) => {
      const offset = new URL(request.url).searchParams.get("offset")!;
      offsets.push(offset);
      if (offset === "0") return json({ data: firstPage });
      if (offset === "50") {
        return json({ data: [key({ hash: "target-hash", name: "target" })] });
      }
      return json({ data: [] });
    });

    await expect(client.findKeysByExactName("target")).resolves.toMatchObject({
      status: "one",
      matches: [{ hash: "target-hash" }],
    });
    expect(offsets).toEqual(["0", "50", "51"]);
  });

  test("fails closed when the pagination bound is exhausted", async () => {
    let boundedPage = 0;
    const bounded = adapter(
      async () => {
        boundedPage += 1;
        return json({
          data: [
            key({ hash: `hash-${boundedPage}-a`, name: "target" }),
            key({ hash: `hash-${boundedPage}-b`, name: "other" }),
          ],
        });
      },
      { maxPages: 2 },
    );

    await expect(bounded.findKeysByExactName("target")).rejects.toMatchObject({
      code: "pagination-bound",
    });
  });

  test("rejects malformed, repeated-hash, and oversized list responses", async () => {
    const malformed = adapter(async () => json({ data: [{ name: "target" }] }));
    const invalidJson = adapter(
      async () =>
        new Response("not JSON", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const repeatedHash = adapter(
      async (request) => {
        const offset = new URL(request.url).searchParams.get("offset");
        return json({
          data:
            offset === "0" || offset === "1"
              ? [key({ hash: "same-hash", name: "target" })]
              : [],
        });
      },
    );
    const tooLarge = adapter(
      async () =>
        new Response("x".repeat(129), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { maxResponseBytes: 128 },
    );

    await expect(
      malformed.findKeysByExactName("target"),
    ).rejects.toBeInstanceOf(OpenRouterManagementAdapterError);
    await expect(
      invalidJson.findKeysByExactName("target"),
    ).rejects.toMatchObject({
      code: "invalid-response",
    });
    await expect(
      repeatedHash.findKeysByExactName("target"),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(tooLarge.findKeysByExactName("target")).rejects.toMatchObject({
      code: "response-too-large",
    });
  });

  test("classifies malformed UTF-8 as an invalid response", async () => {
    const client = adapter(
      async () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(client.findKeysByExactName("target")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  test("cancels a hanging body and waits for termination at timeout", async () => {
    let bodyCancelled = false;
    let transportTerminated = false;
    const client = adapter(
      async () => {
        try {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => {
                bodyCancelled = true;
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        } finally {
          transportTerminated = true;
        }
      },
      { requestTimeoutMs: 5 },
    );

    await expect(client.findKeysByExactName("target")).rejects.toMatchObject({
      code: "timeout",
    });
    expect(bodyCancelled).toBe(true);
    expect(transportTerminated).toBe(true);
  });

  test("serializes exact bounded micros and rejects a lossy cap before provider contact", async () => {
    const bodies: string[] = [];
    const limits = [300_001n, OPENROUTER_EXACT_LIMIT_MAX_MICROS];
    let index = 0;
    const client = mutationAdapter(async (request) => {
      bodies.push(request.body!);
      const limitMicros = limits[index++]!;
      return json(
        {
          key: `runtime-key-${index}`,
          data: key({
            hash: `created-hash-${index}`,
            name: "opaque provider name",
            limit: Number(
              limitMicros === limits[0] ? "0.300001" : "2251799813.685247",
            ),
          }),
        },
        201,
      );
    });

    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "opaque provider name",
        limitMicros: micros(limits[0]!),
        expiresAt: EXPIRES_AT,
      }),
    ).resolves.toMatchObject({ status: "created", limitMicros: limits[0] });
    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "opaque provider name",
        limitMicros: micros(limits[1]!),
        expiresAt: EXPIRES_AT,
      }),
    ).resolves.toMatchObject({ status: "created", limitMicros: limits[1] });
    expect(bodies).toEqual([
      `{"name":"opaque provider name","limit":0.300001,"limit_reset":null,"expires_at":"${EXPIRES_AT_ISO}"}`,
      `{"name":"opaque provider name","limit":2251799813.685247,"limit_reset":null,"expires_at":"${EXPIRES_AT_ISO}"}`,
    ]);

    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "opaque provider name",
        limitMicros: 9_007_199_254_740_901n as ReturnType<typeof micros>,
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow("no greater than");
    expect(bodies).toHaveLength(2);
  });

  test("compares create-response expiration instants without losing sub-millisecond precision", async () => {
    const client = mutationAdapter(async () =>
      json(
        {
          key: "runtime-key",
          data: key({
            hash: "created-hash",
            name: "target",
            expiresAt: "2026-09-01T00:00:00.000000001Z",
          }),
        },
        201,
      ),
    );

    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "target",
        limitMicros: micros(1_000_000n),
        expiresAt: EXPIRES_AT,
      }),
    ).resolves.toMatchObject({ status: "ambiguous" });
  });

  test("classifies timeout and every uncertain create response as ambiguous without retrying", async () => {
    let timeoutCalls = 0;
    let timedOutTransportTerminated = false;
    const timedOut = mutationAdapter(
        async (request) => {
          timeoutCalls += 1;
          try {
            await new Promise<void>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                {
                  once: true,
                },
              );
            });
            throw new Error("unreachable");
          } finally {
            timedOutTransportTerminated = true;
          }
        },
        { requestTimeoutMs: 5 },
      );
      const transportFailure = mutationAdapter(async () => {
        throw new Error("connection reset");
      });
      const malformed = mutationAdapter(async () => json({ data: {} }, 201));
      const oversized = mutationAdapter(
        async () =>
          new Response("x".repeat(129), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        { maxResponseBytes: 128 },
      );
      const serverError = mutationAdapter(async () =>
        json({ error: "uncertain" }, 500),
      );

      await expect(
        timedOut.createKeyAfterPersistedIntent({
          intentId: CREATE_INTENT_ID,
          name: "target",
          limitMicros: micros(1n),
          expiresAt: EXPIRES_AT,
        }),
      ).resolves.toMatchObject({ status: "ambiguous", reason: "timeout" });
      expect(timeoutCalls).toBe(1);
      expect(timedOutTransportTerminated).toBe(true);
      await expect(
        transportFailure.createKeyAfterPersistedIntent({
          intentId: CREATE_INTENT_ID,
          name: "target",
          limitMicros: micros(1n),
          expiresAt: EXPIRES_AT,
        }),
      ).resolves.toMatchObject({ status: "ambiguous", reason: "transport" });
      await expect(
        malformed.createKeyAfterPersistedIntent({
          intentId: CREATE_INTENT_ID,
          name: "target",
          limitMicros: micros(1n),
          expiresAt: EXPIRES_AT,
        }),
      ).resolves.toMatchObject({
        status: "ambiguous",
        reason: "invalid-response",
      });
      await expect(
        oversized.createKeyAfterPersistedIntent({
          intentId: CREATE_INTENT_ID,
          name: "target",
          limitMicros: micros(1n),
          expiresAt: EXPIRES_AT,
        }),
      ).resolves.toMatchObject({
        status: "ambiguous",
        reason: "response-too-large",
      });
      await expect(
        serverError.createKeyAfterPersistedIntent({
          intentId: CREATE_INTENT_ID,
          name: "target",
          limitMicros: micros(1n),
          expiresAt: EXPIRES_AT,
        }),
      ).resolves.toMatchObject({
        status: "ambiguous",
      reason: "unexpected-status",
      httpStatus: 500,
    });
  });

  test("classifies rate limiting as retryable without retrying inline", async () => {
    let calls = 0;
    const client = mutationAdapter(async () => {
      calls += 1;
      return json({ error: { code: 429, message: "rate limited" } }, 429);
    });

    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "target",
        limitMicros: micros(1n),
        expiresAt: EXPIRES_AT,
      }),
    ).resolves.toEqual({
      status: "retryable",
      binding: OPENROUTER_PROVIDER_BINDING,
      httpStatus: 429,
    });
    expect(calls).toBe(1);
  });

  test("accepts equivalent RFC 3339 expiration spellings and rejects invalid dates", async () => {
    const responses = ["2026-09-01T00:00:00Z", "2026-02-30T00:00:00Z"];
    const client = mutationAdapter(async () =>
      json(
        {
          key: "runtime-key",
          data: key({
            hash: "created-hash",
            name: "target",
            limit: 0.000001,
            expiresAt: responses.shift(),
          }),
        },
        201,
      ),
    );

    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "target",
        limitMicros: micros(1n),
        expiresAt: EXPIRES_AT,
      }),
    ).resolves.toMatchObject({ status: "created" });
    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "target",
        limitMicros: micros(1n),
        expiresAt: new Date("2026-02-28T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "ambiguous",
      reason: "invalid-response",
    });
  });

  test("keeps undocumented 409 and 422 mutation outcomes ambiguous", async () => {
    for (const httpStatus of [409, 422]) {
      const createClient = mutationAdapter(async () =>
        json({ error: "undocumented" }, httpStatus),
      );
      const disableClient = adapter(async () =>
        json({ error: "undocumented" }, httpStatus),
      );

      await expect(
        createClient.createKeyAfterPersistedIntent({
          intentId: CREATE_INTENT_ID,
          name: "target",
          limitMicros: micros(1n),
          expiresAt: EXPIRES_AT,
        }),
      ).resolves.toMatchObject({
        status: "ambiguous",
        reason: "unexpected-status",
        httpStatus,
      });
      await expect(
        disableClient.disableKey("exact-hash"),
      ).resolves.toMatchObject({
        status: "ambiguous",
        reason: "unexpected-status",
        httpStatus,
      });
    }
  });

  test("keeps exact-name lookup outside the persisted POST capability", async () => {
    const methods: string[] = [];
    const client = adapter(async (request) => {
      methods.push(request.method);
      return json(
        {
          key: "runtime-key",
          data: key({ hash: "created", name: "target", limit: 0.000001 }),
        },
        201,
      );
    });

    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "target",
        limitMicros: micros(1n),
        expiresAt: EXPIRES_AT,
      }),
    ).resolves.toMatchObject({
      status: "created",
      key: { hash: "created" },
    });
    expect(methods).toEqual(["POST"]);
  });

  test("disables only the exact opaque hash with a non-destructive PATCH", async () => {
    const requests: OpenRouterManagementRequest[] = [];
    const exactHash = "Hash/With+Opaque=Identity";
    const client = adapter(async (request) => {
      requests.push(request);
      return json({
        data: key({ hash: exactHash, name: "target", disabled: true }),
      });
    });

    await expect(client.disableKey(exactHash)).resolves.toMatchObject({
      status: "disabled",
      key: { hash: exactHash, disabled: true },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url.toString()).toBe(
      "https://openrouter.ai/api/v1/keys/Hash%2FWith%2BOpaque%3DIdentity",
    );
    expect(requests[0]?.body).toBe('{"disabled":true}');
  });

  test("treats disable identity mismatch and timeout as ambiguous", async () => {
    const mismatch = adapter(async () =>
      json({
        data: key({ hash: "different", name: "target", disabled: true }),
      }),
    );
    const timedOut = adapter(
      async (request) => {
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
      { requestTimeoutMs: 5 },
    );

    await expect(mismatch.disableKey("expected")).resolves.toMatchObject({
      status: "ambiguous",
      reason: "invalid-response",
    });
    await expect(timedOut.disableKey("expected")).resolves.toMatchObject({
      status: "ambiguous",
      reason: "timeout",
    });
  });

  test("source contains no destructive provider method or default network transport", async () => {
    const source = await readFile(
      new URL("../src/lib/openrouter-management-adapter.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/method:\s*["']DELETE["']/);
    expect(source).not.toContain("deleteKey");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("chat/completions");
    expect(source).not.toContain("OPENROUTER_API_KEY");
  });

  test("rejects malformed mutation inputs before invoking the transport", async () => {
    let calls = 0;
    const client = adapter(async () => {
      calls += 1;
      return json({ data: [] });
    });

    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: CREATE_INTENT_ID,
        name: "",
        limitMicros: micros(1n),
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow("opaque string");
    await expect(
      client.createKeyAfterPersistedIntent({
        intentId: "not-a-persisted-uuid",
        name: "target",
        limitMicros: micros(1n),
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow("intent id is invalid");
    expect(() => micros(-1n)).toThrow("nonnegative bigint");
    expect(() =>
      (micros as (value: unknown) => unknown)(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow("nonnegative bigint");
    await expect(client.disableKey(" bad-hash ")).rejects.toThrow(
      "hash is invalid",
    );
    expect(calls).toBe(0);
  });

  test("documents and enforces the shared opaque provider-name bound", async () => {
    let calls = 0;
    const client = adapter(async () => {
      calls += 1;
      return json({ data: [] });
    });
    const maximumName = "n".repeat(OPENROUTER_KEY_NAME_MAX_LENGTH);

    expect(OPENROUTER_KEY_NAME_MAX_LENGTH).toBe(160);
    await expect(
      client.findKeysByExactName(maximumName),
    ).resolves.toMatchObject({
      status: "none",
      name: maximumName,
    });
    await expect(client.findKeysByExactName(`${maximumName}x`)).rejects.toThrow(
      "opaque string",
    );
    expect(calls).toBe(1);
  });

  test("keeps configured resource limits inside hard adapter bounds", () => {
    const transport = async () => json({ data: [] });

    expect(() => adapter(transport, { requestTimeoutMs: 60_001 })).toThrow(
      "no greater than 60000",
    );
    expect(() => adapter(transport, { maxResponseBytes: 8_388_609 })).toThrow(
      "no greater than 8388608",
    );
    expect(() => adapter(transport, { maxPages: 101 })).toThrow(
      "no greater than 100",
    );
  });
});
