import type { Pool, PoolClient } from "pg";

import { closeDb, getPool } from "@/lib/db";

const RELEASE_STEP = "operational-indexes-v2";
const RELEASE_LOCK_NAMESPACE = 1_349_481_332;
const RELEASE_LOCK_OPERATION = 1_768_704_356;
const RELEASE_LOCK_WAIT_MS = 15 * 60 * 1_000;
const RELEASE_LOCK_POLL_MS = 250;

interface OperationalIndex {
  name: string;
  createSql: string;
  definitionFragments: string[];
}

const OPERATIONAL_INDEXES: OperationalIndex[] = [
  {
    name: "reviews_running_started_at_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "reviews_running_started_at_idx" ON "reviews" ("started_at") WHERE "status" = \'running\'',
    definitionFragments: ["public.reviews", "(started_at)", "where", "status", "running"],
  },
  {
    name: "jobs_running_locked_at_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_running_locked_at_idx" ON "jobs" ("locked_at") WHERE "status" = \'running\'',
    definitionFragments: ["public.jobs", "(locked_at)", "where", "status", "running"],
  },
  {
    name: "webhook_deliveries_completed_at_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_deliveries_completed_at_idx" ON "webhook_deliveries" ("completed_at") WHERE "completed_at" IS NOT NULL',
    definitionFragments: [
      "public.webhook_deliveries",
      "(completed_at)",
      "where",
      "completed_at is not null",
    ],
  },
  {
    name: "respond_deliveries_pr_identity_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "respond_deliveries_pr_identity_idx" ON "respond_deliveries" ("source_github_installation_id", "source_github_repo_id", "issue_number", "source_head_sha") WHERE "is_pr" AND "state" IN (\'prepared\', \'delivering\')',
    definitionFragments: [
      "public.respond_deliveries",
      "(source_github_installation_id, source_github_repo_id, issue_number, source_head_sha)",
      "where",
      "is_pr",
      "state",
      "prepared",
      "delivering",
    ],
  },
];

interface IndexState {
  indisvalid: boolean;
  indisready: boolean;
  definition: string;
}

export async function ensureOperationalIndexes(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  let locked = false;
  try {
    await acquireReleaseLock(client);
    locked = true;
    await ensureReleaseStepsTable(client);
    const completed: string[] = [];
    for (const index of OPERATIONAL_INDEXES) {
      let state = await loadIndexState(client, index.name);
      if (state && (!state.indisvalid || !state.indisready)) {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "public"."${index.name}"`);
        state = null;
      }
      if (!state) {
        await client.query(index.createSql);
        state = await loadIndexState(client, index.name);
      }
      assertExpectedIndex(index, state);
      completed.push(index.name);
    }

    await client.query(
      `INSERT INTO release_steps (name, completed_at, details)
       VALUES ($1, now(), $2::jsonb)
       ON CONFLICT (name) DO UPDATE
         SET completed_at = EXCLUDED.completed_at,
             details = EXCLUDED.details`,
      [RELEASE_STEP, JSON.stringify({ indexes: completed })],
    );
    return completed;
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock($1, $2)", [
          RELEASE_LOCK_NAMESPACE,
          RELEASE_LOCK_OPERATION,
        ])
        .catch(() => undefined);
    }
    client.release();
  }
}

async function ensureReleaseStepsTable(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "release_steps" (
       "name" text PRIMARY KEY NOT NULL,
       "completed_at" timestamp with time zone NOT NULL,
       "details" jsonb NOT NULL
     )`,
  );
}

async function acquireReleaseLock(client: PoolClient): Promise<void> {
  const deadline = Date.now() + RELEASE_LOCK_WAIT_MS;
  while (true) {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [RELEASE_LOCK_NAMESPACE, RELEASE_LOCK_OPERATION],
    );
    if (result.rows[0]?.acquired === true) return;
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for the operational index release lock");
    }
    await new Promise((resolve) => setTimeout(resolve, RELEASE_LOCK_POLL_MS));
  }
}

async function loadIndexState(client: PoolClient, name: string): Promise<IndexState | null> {
  const result = await client.query<IndexState>(
    `SELECT pg_index.indisvalid,
            pg_index.indisready,
            pg_get_indexdef(pg_index.indexrelid) AS definition
       FROM pg_index
      WHERE pg_index.indexrelid = to_regclass($1)`,
    [`public.${name}`],
  );
  return result.rows[0] ?? null;
}

function assertExpectedIndex(index: OperationalIndex, state: IndexState | null): void {
  if (!state || !state.indisvalid || !state.indisready) {
    throw new Error(`operational index ${index.name} is not valid and ready`);
  }
  const normalized = state.definition.toLowerCase().replace(/["()]/gu, "").replace(/\s+/gu, " ");
  for (const fragment of index.definitionFragments) {
    const expected = fragment.toLowerCase().replace(/["()]/gu, "").replace(/\s+/gu, " ");
    if (!normalized.includes(expected)) {
      throw new Error(`operational index ${index.name} has an unexpected definition`);
    }
  }
}

async function main(): Promise<void> {
  try {
    const indexes = await ensureOperationalIndexes(getPool());
    console.log(`operational indexes ready: ${indexes.join(", ")}`);
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
