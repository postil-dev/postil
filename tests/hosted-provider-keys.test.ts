import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getSealingKey, unseal } from "@/lib/crypto/seal";
import type { Database } from "@/lib/db";
import {
  enqueueHostedProviderKeyProvision,
  hostedProviderKeyName,
  provisionHostedProviderKey,
} from "@/lib/hosted-provider-keys";
import "./quiet-console";

type EntitlementRow = {
  includedUsageMicros: number;
  overageHardCapMicros: number | null;
};

type InsertedHostedKey = {
  orgId: number;
  keyCiphertext: Buffer;
  openRouterKeyHash: string;
  keyName: string;
};

type FakeDatabaseState = {
  hostedRows: Array<{ orgId: number }>;
  entitlementRows: EntitlementRow[];
  inserted: InsertedHostedKey[];
};

const ORIGINAL_MANAGEMENT_KEY = process.env.OPENROUTER_MANAGEMENT_API_KEY;
const ORIGINAL_SEALING_KEY = process.env.POSTIL_SEALING_KEY;

function fakeDb(state: FakeDatabaseState): Database {
  let selectedTable: unknown;
  const db = {
    select() {
      const chain = {
        from(table: unknown) {
          selectedTable = table;
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          if (
            typeof selectedTable === "object" &&
            selectedTable !== null &&
            "keyCiphertext" in selectedTable
          ) {
            return Promise.resolve(state.hostedRows);
          }
          if (
            typeof selectedTable === "object" &&
            selectedTable !== null &&
            "includedUsageMicros" in selectedTable
          ) {
            return Promise.resolve(state.entitlementRows);
          }
          throw new Error("unexpected table selected by hosted key test");
        },
      };
      return chain;
    },
    insert(table: unknown) {
      if (
        typeof table !== "object" ||
        table === null ||
        !("keyCiphertext" in table)
      ) {
        throw new Error("unexpected table inserted by hosted key test");
      }
      return {
        values(values: InsertedHostedKey) {
          state.inserted.push(values);
          return Promise.resolve();
        },
      };
    },
  };
  return db as unknown as Database;
}

function state(input: Partial<FakeDatabaseState> = {}): FakeDatabaseState {
  return {
    hostedRows: input.hostedRows ?? [],
    entitlementRows:
      input.entitlementRows ??
      [{ includedUsageMicros: 1_500_001, overageHardCapMicros: 499_999 }],
    inserted: input.inserted ?? [],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.OPENROUTER_MANAGEMENT_API_KEY = "management-value-for-tests";
  process.env.POSTIL_SEALING_KEY = "11".repeat(32);
});

afterEach(() => {
  if (ORIGINAL_MANAGEMENT_KEY === undefined) {
    delete process.env.OPENROUTER_MANAGEMENT_API_KEY;
  } else {
    process.env.OPENROUTER_MANAGEMENT_API_KEY = ORIGINAL_MANAGEMENT_KEY;
  }
  if (ORIGINAL_SEALING_KEY === undefined) {
    delete process.env.POSTIL_SEALING_KEY;
  } else {
    process.env.POSTIL_SEALING_KEY = ORIGINAL_SEALING_KEY;
  }
});

describe("provisionHostedProviderKey", () => {
  test("creates, seals, and stores an organization runtime key", async () => {
    const databaseState = state();
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const runtimeKey = "runtime-value-created-for-test";
    const fetchImpl = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = {
        method: init?.method ?? "GET",
        url: String(input),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      requests.push(request);
      if (request.method === "GET") return jsonResponse({ data: [] });
      return jsonResponse({
        key: runtimeKey,
        data: {
          hash: "created-hash",
          name: hostedProviderKeyName(42),
          limit: 2,
          disabled: false,
        },
      });
    };

    await expect(
      provisionHostedProviderKey(fakeDb(databaseState), 42, fetchImpl),
    ).resolves.toEqual({
      status: "provisioned",
      keyName: "postil-org-42",
      openRouterKeyHash: "created-hash",
    });

    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(requests[0]?.url).toContain(
      "/api/v1/keys?include_disabled=true&offset=0",
    );
    expect(requests[1]?.body).toEqual({ name: "postil-org-42", limit: 2 });
    expect(databaseState.inserted).toHaveLength(1);
    const inserted = databaseState.inserted[0]!;
    expect(inserted).toMatchObject({
      orgId: 42,
      openRouterKeyHash: "created-hash",
      keyName: "postil-org-42",
    });
    expect(inserted.keyCiphertext).toBeInstanceOf(Buffer);
    expect(inserted.keyCiphertext.includes(Buffer.from(runtimeKey))).toBe(false);
    expect(unseal(inserted.keyCiphertext, getSealingKey())).toBe(runtimeKey);
  });

  test("returns early when the organization already has a local key", async () => {
    const databaseState = state({ hostedRows: [{ orgId: 42 }] });
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("provider must not be called for an existing local row");
    };

    await expect(
      provisionHostedProviderKey(fakeDb(databaseState), 42, fetchImpl),
    ).resolves.toEqual({ status: "existing" });
    expect(databaseState.inserted).toEqual([]);
  });

  test("preserves a sub-dollar entitlement in the provider limit", async () => {
    const databaseState = state({
      entitlementRows: [
        { includedUsageMicros: 300_000, overageHardCapMicros: null },
      ],
    });
    let createBody: unknown;
    const fetchImpl = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (init?.method === "GET") return jsonResponse({ data: [] });
      createBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse({
        key: "sub-dollar-runtime-value",
        data: { hash: "sub-dollar-hash", name: "postil-org-42" },
      });
    };

    await provisionHostedProviderKey(fakeDb(databaseState), 42, fetchImpl);

    expect(createBody).toEqual({ name: "postil-org-42", limit: 0.3 });
  });

  test("skips provisioning for a zero entitlement", async () => {
    const databaseState = state({
      entitlementRows: [
        { includedUsageMicros: 0, overageHardCapMicros: null },
      ],
    });
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("provider must not be called for a zero entitlement");
    };

    await expect(
      provisionHostedProviderKey(fakeDb(databaseState), 42, fetchImpl),
    ).resolves.toEqual({ status: "skipped", reason: "zero-entitlement" });
    expect(databaseState.inserted).toEqual([]);
  });

  test("deletes an orphaned provider key before recreating it", async () => {
    const databaseState = state();
    const requests: Array<{ method: string; url: string }> = [];
    const fetchImpl = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = { method: init?.method ?? "GET", url: String(input) };
      requests.push(request);
      if (request.method === "GET") {
        if (request.url.endsWith("offset=0")) {
          return jsonResponse({
            data: Array.from({ length: 100 }, (_, index) => ({
              name: `unrelated-${index}`,
              hash: `other-hash-${index}`,
              disabled: false,
            })),
          });
        }
        return jsonResponse({
          data: [
            { name: "postil-org-42", hash: "orphan-hash", disabled: true },
          ],
        });
      }
      if (request.method === "DELETE") return jsonResponse({ deleted: true });
      return jsonResponse({
        key: "replacement-runtime-value",
        data: { hash: "replacement-hash", name: "postil-org-42" },
      });
    };

    await expect(
      provisionHostedProviderKey(fakeDb(databaseState), 42, fetchImpl),
    ).resolves.toMatchObject({
      status: "provisioned",
      openRouterKeyHash: "replacement-hash",
    });
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "GET",
      "DELETE",
      "POST",
    ]);
    expect(requests[1]?.url).toContain("offset=100");
    expect(requests[2]?.url).toEndWith("/api/v1/keys/orphan-hash");
  });

  test("skips organizations without an entitlement", async () => {
    const databaseState = state({ entitlementRows: [] });
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("provider must not be called without an entitlement");
    };

    await expect(
      provisionHostedProviderKey(fakeDb(databaseState), 42, fetchImpl),
    ).resolves.toEqual({
      status: "skipped",
      reason: "missing-entitlement",
    });
    expect(databaseState.inserted).toEqual([]);
  });

  test("succeeds as a no-op without a management key", async () => {
    delete process.env.OPENROUTER_MANAGEMENT_API_KEY;
    const databaseState = state();
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("provider must not be called without management auth");
    };

    await expect(
      provisionHostedProviderKey(fakeDb(databaseState), 42, fetchImpl),
    ).resolves.toEqual({
      status: "skipped",
      reason: "missing-management-key",
    });
    expect(databaseState.inserted).toEqual([]);
  });
});

describe("enqueueHostedProviderKeyProvision", () => {
  test("queues one normal-retry job with five attempts", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const database = {
      execute: async () => ({ rows: [] }),
      select() {
        const chain = {
          from() {
            return chain;
          },
          where() {
            return chain;
          },
          limit() {
            return Promise.resolve([]);
          },
        };
        return chain;
      },
      insert() {
        return {
          values(values: Record<string, unknown>) {
            inserted.push(values);
            return Promise.resolve();
          },
        };
      },
    };

    await expect(
      enqueueHostedProviderKeyProvision(
        database as unknown as Pick<Database, "execute" | "insert" | "select">,
        42,
      ),
    ).resolves.toBe(true);
    expect(inserted).toEqual([
      {
        kind: "hosted-key-provision",
        payload: { orgId: 42 },
        maxAttempts: 5,
      },
    ]);
  });

  test("does not duplicate a queued or running organization job", async () => {
    let insertCalled = false;
    const database = {
      execute: async () => ({ rows: [] }),
      select() {
        const chain = {
          from() {
            return chain;
          },
          where() {
            return chain;
          },
          limit() {
            return Promise.resolve([{ id: 9 }]);
          },
        };
        return chain;
      },
      insert() {
        insertCalled = true;
        return { values: async () => undefined };
      },
    };

    await expect(
      enqueueHostedProviderKeyProvision(
        database as unknown as Pick<Database, "execute" | "insert" | "select">,
        42,
      ),
    ).resolves.toBe(false);
    expect(insertCalled).toBe(false);
  });
});
