import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";

let queryCount = 0;
let queryImpl: (text: string) => Promise<unknown>;

mock.module("@/lib/db", () => ({
  getPool: () => ({
    query: async (text: string) => {
      queryCount += 1;
      return queryImpl(text);
    },
  }),
}));

const livenessRoute = await import("@/app/api/health/route");
const dependenciesRoute = await import("@/app/api/health/dependencies/route");
const monitorRoute = await import("@/app/api/health/monitor/route");

beforeEach(() => {
  queryCount = 0;
  queryImpl = async () => ({ rows: [{ ok: 1 }] });
});

describe("/api/health", () => {
  test("is cheap process liveness and does not need database configuration", async () => {
    delete process.env.DATABASE_URL;

    const response = await livenessRoute.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "web" });
    expect(queryCount).toBe(0);
  });

  test("does not import the database module", async () => {
    const source = await readFile(
      new URL("../src/app/api/health/route.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("@/lib/db");
    expect(source).not.toMatch(/\bget(Db|Pool)\b/);
  });
});

describe("/api/health/dependencies", () => {
  test("returns 200 when the database probe succeeds", async () => {
    queryImpl = async (text: string) => {
      expect(text).toBe("SELECT 1");
      return { rows: [{ ok: 1 }] };
    };

    const response = await dependenciesRoute.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, database: "up" });
    expect(queryCount).toBe(1);
  });

  test("returns 503 when the database probe fails", async () => {
    queryImpl = async () => {
      throw new Error("database unavailable");
    };

    const response = await dependenciesRoute.GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      database: "down",
      error: "database health check failed",
    });
    expect(queryCount).toBe(1);
  });
});

describe("/api/health/monitor", () => {
  test("reports healthy only when process, collection, and heartbeat delivery are fresh", async () => {
    queryImpl = async (text: string) => {
      expect(text).toContain("component = 'monitor'");
      expect(text).toContain("last_completed_at");
      expect(text).toContain("component = 'monitor-heartbeat-delivery'");
      return {
        rows: [
          {
            process_age_seconds: "30",
            collection_age_seconds: "45",
            heartbeat_delivery_age_seconds: "60",
          },
        ],
      };
    };

    const response = await monitorRoute.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      monitor: {
        process: "up",
        collection: "up",
        heartbeatDelivery: "up",
      },
    });
    expect(queryCount).toBe(1);
  });

  test("distinguishes stale and missing monitor evidence", async () => {
    queryImpl = async () => ({
      rows: [
        {
          process_age_seconds: "901",
          collection_age_seconds: "2147483647",
          heartbeat_delivery_age_seconds: "900",
        },
      ],
    });

    const response = await monitorRoute.GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      monitor: {
        process: "stale",
        collection: "missing",
        heartbeatDelivery: "stale",
      },
    });
  });

  test("fails closed without disclosing database errors", async () => {
    queryImpl = async () => {
      throw new Error("private database endpoint");
    };

    const response = await monitorRoute.GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      monitor: {
        process: "unknown",
        collection: "unknown",
        heartbeatDelivery: "unknown",
      },
    });
  });
});
