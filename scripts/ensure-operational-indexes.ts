import type { Pool, PoolClient } from "pg";

import { closeDb, getPool } from "@/lib/db";

const RELEASE_STEP = "operational-indexes-v6";
const RELEASE_LOCK_NAMESPACE = 1_349_481_332;
const RELEASE_LOCK_OPERATION = 1_768_704_356;
const RELEASE_LOCK_WAIT_MS = 15 * 60 * 1_000;
const RELEASE_LOCK_POLL_MS = 250;

interface OperationalIndex {
  name: string;
  createSql: string;
  definitionFragments: string[];
  requiredColumns?: {
    relation: string;
    columns: string[];
  };
}

const OPERATIONAL_INDEXES: OperationalIndex[] = [
  {
    name: "reviews_publication_lifecycle_pending_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "reviews_publication_lifecycle_pending_idx" ON "reviews" ("finished_at") WHERE "status" = \'completed\' AND "publication_lifecycle_required_at" IS NOT NULL AND "publication_lifecycle_reconciled_at" IS NULL',
    definitionFragments: [
      "public.reviews",
      "finished_at",
      "where",
      "status",
      "completed",
      "publication_lifecycle_required_at is not null",
      "publication_lifecycle_reconciled_at is null",
    ],
  },
  {
    name: "cli_tokens_refresh_session_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "cli_tokens_refresh_session_idx" ON "cli_tokens" ("refresh_session_id")',
    definitionFragments: ["public.cli_tokens", "refresh_session_id"],
  },
  {
    name: "reviews_running_started_at_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "reviews_running_started_at_idx" ON "reviews" ("started_at") WHERE "status" = \'running\'',
    definitionFragments: [
      "public.reviews",
      "(started_at)",
      "where",
      "status",
      "running",
    ],
  },
  {
    name: "jobs_running_locked_at_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_running_locked_at_idx" ON "jobs" ("locked_at") WHERE "status" = \'running\'',
    definitionFragments: [
      "public.jobs",
      "(locked_at)",
      "where",
      "status",
      "running",
    ],
  },
  {
    name: "jobs_running_org_concurrency_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_running_org_concurrency_idx" ON "jobs" ("kind", ("payload"->>\'sourceOrgId\')) WHERE "status" = \'running\'',
    definitionFragments: [
      "public.jobs",
      "kind",
      "payload ->> 'sourceOrgId'",
      "where",
      "status",
      "running",
    ],
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
  {
    name: "finding_approvals_github_comment_idx",
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "finding_approvals_github_comment_idx" ON "finding_approvals" ("source_github_installation_id", "source_github_repo_id", "source_comment_kind", "source_github_comment_id") WHERE "source" = \'github\'',
    definitionFragments: [
      "public.finding_approvals",
      "source_github_installation_id",
      "source_github_repo_id",
      "source_comment_kind",
      "source_github_comment_id",
      "where",
      "source",
      "github",
    ],
  },
  {
    name: "finding_approvals_github_delivery_idx",
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "finding_approvals_github_delivery_idx" ON "finding_approvals" ("source_webhook_delivery_id") WHERE "source" = \'github\'',
    definitionFragments: [
      "public.finding_approvals",
      "source_webhook_delivery_id",
      "where",
      "source",
      "github",
    ],
  },
  {
    name: "ilert_alert_events_canary_observation_idx",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ilert_alert_events_canary_observation_idx" ON "ilert_alert_events" USING btree ("alert_key", "event_type", "alert_source_id") WHERE "alert_key" IS NOT NULL',
    definitionFragments: [
      "public.ilert_alert_events",
      "using btree",
      "(alert_key, event_type, alert_source_id)",
      "where",
      "alert_key is not null",
    ],
    requiredColumns: {
      relation: "public.ilert_alert_events",
      columns: ["alert_key", "event_type", "alert_source_id"],
    },
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
    await assertOperationalIndexDependencies(client);
    await ensureReleaseStepsTable(client);
    const completed: string[] = [];
    for (const index of OPERATIONAL_INDEXES) {
      let state = await loadIndexState(client, index.name);
      if (state && !isExpectedIndex(index, state)) {
        await client.query(
          `DROP INDEX CONCURRENTLY IF EXISTS "public"."${index.name}"`,
        );
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

async function assertOperationalIndexDependencies(
  client: PoolClient,
): Promise<void> {
  for (const index of OPERATIONAL_INDEXES) {
    const required = index.requiredColumns;
    if (!required) continue;
    const result = await client.query<{ attname: string }>(
      `SELECT attribute.attname
         FROM pg_attribute AS attribute
        WHERE attribute.attrelid = to_regclass($1)
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attname = ANY($2::text[])`,
      [required.relation, required.columns],
    );
    const present = new Set(result.rows.map((row) => row.attname));
    const missing = required.columns.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new Error(
        `operational index ${index.name} requires migrated columns ${required.relation}.${missing.join(
          `, ${required.relation}.`,
        )}`,
      );
    }
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
      throw new Error(
        "timed out waiting for the operational index release lock",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RELEASE_LOCK_POLL_MS));
  }
}

async function loadIndexState(
  client: PoolClient,
  name: string,
): Promise<IndexState | null> {
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

function assertExpectedIndex(
  index: OperationalIndex,
  state: IndexState | null,
): void {
  if (!state || !state.indisvalid || !state.indisready) {
    throw new Error(`operational index ${index.name} is not valid and ready`);
  }
  if (!hasExpectedDefinition(index, state.definition)) {
    throw new Error(
      `operational index ${index.name} has an unexpected definition`,
    );
  }
}

function isExpectedIndex(
  index: OperationalIndex,
  state: IndexState,
): boolean {
  return state.indisvalid &&
    state.indisready &&
    hasExpectedDefinition(index, state.definition);
}

function hasExpectedDefinition(
  index: OperationalIndex,
  definition: string,
): boolean {
  const normalized = definition
    .toLowerCase()
    .replace(/["()]/gu, "")
    .replace(/\s+/gu, " ");
  for (const fragment of index.definitionFragments) {
    const expected = fragment
      .toLowerCase()
      .replace(/["()]/gu, "")
      .replace(/\s+/gu, " ");
    if (!normalized.includes(expected)) return false;
  }
  return true;
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
