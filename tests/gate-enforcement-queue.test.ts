import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Pool, type PoolClient } from "pg";

import {
  enqueueGateEnforcementSweepOnce,
  findActiveGateEnforcementSweep,
  getGateEnforcementSweepStatus,
} from "@/lib/queue";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describe("gate enforcement sweep admission", () => {
  test("uses one durable dedupe key per organization", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        return sql.includes("INSERT INTO jobs") ? { rows: [{ id: "42" }] } : { rows: [] };
      },
      release() {},
    };
    const pool = {
      connect: async () => client,
    };

    expect(await enqueueGateEnforcementSweepOnce(pool as never, { orgId: 7 })).toBe(42);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO jobs"));
    expect(JSON.parse(String(insert?.values[0]))).toMatchObject({
      scopeKey: "org:7",
      orgId: 7,
    });
    expect(insert?.values[2]).toBe("org:7");
    expect(calls.some((call) => call.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("returns null when an active or recent sweep exists for the scope", async () => {
    const client = {
      query: async () => ({ rows: [] }),
      release() {},
    };
    const pool = { connect: async () => client };
    expect(await enqueueGateEnforcementSweepOnce(pool as never)).toBeNull();
  });

  test("finds and scopes the durable job used for completion polling", async () => {
    const calls: unknown[][] = [];
    const pool = {
      query: async (_sql: string, values: unknown[]) => {
        calls.push(values);
        return calls.length === 1
          ? { rows: [{ id: "42" }] }
          : { rows: [{ status: "done" }] };
      },
    };

    expect(await findActiveGateEnforcementSweep(pool as never, 7)).toBe(42);
    expect(await getGateEnforcementSweepStatus(pool as never, { jobId: 42, orgId: 7 }))
      .toBe("done");
    expect(calls).toEqual([["org:7"], [42, "org:7"]]);
  });

  test("rejects invalid job ids before querying", async () => {
    let queried = false;
    const pool = { query: async () => { queried = true; return { rows: [] }; } };
    expect(await getGateEnforcementSweepStatus(pool as never, { jobId: -1, orgId: 7 }))
      .toBeNull();
    expect(queried).toBe(false);
  });
});

describeDb("gate enforcement sweep concurrent admission", () => {
  const schemaName = `gate_sweep_queue_${process.pid}_${Date.now()}`;
  let backingPool: Pool;
  let scopedPool: { connect: () => Promise<PoolClient> };

  beforeAll(async () => {
    backingPool = new Pool({ connectionString: TEST_URL });
    await backingPool.query(`CREATE SCHEMA "${schemaName}"`);
    await backingPool.query(`
      CREATE TABLE "${schemaName}".jobs (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        kind text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL,
        run_after timestamptz NOT NULL,
        max_attempts integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    scopedPool = {
      connect: async () => {
        const client = await backingPool.connect();
        await client.query(`SET search_path TO "${schemaName}"`);
        return client;
      },
    };
  });

  afterAll(async () => {
    if (!backingPool) return;
    await backingPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await backingPool.end();
  });

  test("admits exactly one sweep when two workers race for the same scope", async () => {
    const results = await Promise.all([
      enqueueGateEnforcementSweepOnce(scopedPool as never, { orgId: 777 }),
      enqueueGateEnforcementSweepOnce(scopedPool as never, { orgId: 777 }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    const count = await backingPool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM "${schemaName}".jobs
      WHERE kind = 'gate-enforcement-sweep'
        AND payload->>'scopeKey' = 'org:777'
        AND status IN ('queued', 'running')
    `);
    expect(count.rows[0]?.count).toBe("1");
  });
});
