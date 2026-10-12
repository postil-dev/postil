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
  /**
   * Rebuild a valid index whose definition differs. Only a non-unique index
   * that enforces no data invariant may opt in; every other index with an
   * unexpected definition fails closed and stays in place.
   */
  repairDefinitionDrift?: boolean;
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
    repairDefinitionDrift: true,
  },
];

/**
 * Indexes the managed release command builds itself. The managed path does
 * not run the full reconciliation, so it creates only indexes introduced
 * together with a reviewed migration and leaves every other index untouched.
 */
export const MANAGED_RELEASE_OPERATIONAL_INDEXES: readonly string[] = [
  "ilert_alert_events_canary_observation_idx",
];
const MANAGED_RELEASE_LOCK_WAIT_MS = 60_000;
const MANAGED_RELEASE_STATEMENT_TIMEOUT_MS = 120_000;

export interface EnsureOperationalIndexesOptions {
  /**
   * Reconcile only MANAGED_RELEASE_OPERATIONAL_INDEXES under bounded lock and
   * statement waits. The release step row describes the full reconciliation
   * and is not written.
   */
  managedRelease?: boolean;
}

interface IndexState {
  indisvalid: boolean;
  indisready: boolean;
  enforcesInvariant: boolean;
  definition: string;
}

export async function ensureOperationalIndexes(
  pool: Pool,
  options: EnsureOperationalIndexesOptions = {},
): Promise<string[]> {
  const managedRelease = options.managedRelease === true;
  const indexes = managedRelease
    ? OPERATIONAL_INDEXES.filter((index) =>
      MANAGED_RELEASE_OPERATIONAL_INDEXES.includes(index.name)
    )
    : OPERATIONAL_INDEXES;
  if (managedRelease && indexes.length !== MANAGED_RELEASE_OPERATIONAL_INDEXES.length) {
    throw new Error("managed release operational indexes are not all defined");
  }
  const client = await pool.connect();
  let locked = false;
  let statementTimeoutSet = false;
  try {
    await acquireReleaseLock(
      client,
      managedRelease ? MANAGED_RELEASE_LOCK_WAIT_MS : RELEASE_LOCK_WAIT_MS,
    );
    locked = true;
    if (managedRelease) {
      // A concurrent build waits for older transactions; the bound keeps a
      // blocked build from holding the release command. A cancelled build
      // leaves an invalid index that the next run drops and rebuilds.
      await client.query(
        `SET statement_timeout = ${MANAGED_RELEASE_STATEMENT_TIMEOUT_MS}`,
      );
      statementTimeoutSet = true;
    }
    await assertOperationalIndexDependencies(client, indexes);
    if (!managedRelease) await ensureReleaseStepsTable(client);
    const completed: string[] = [];
    for (const index of indexes) {
      let state = await loadIndexState(client, index.name);
      if (state && shouldRebuildIndex(index, state)) {
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

    if (managedRelease) return completed;
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
    if (statementTimeoutSet) {
      await client.query("RESET statement_timeout").catch(() => undefined);
    }
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
  indexes: readonly OperationalIndex[],
): Promise<void> {
  for (const index of indexes) {
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

async function acquireReleaseLock(
  client: PoolClient,
  waitMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs;
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
            (pg_index.indisunique
              OR pg_index.indisprimary
              OR pg_index.indisexclusion
              OR EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE pg_constraint.conindid = pg_index.indexrelid
              )) AS "enforcesInvariant",
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

/**
 * An interrupted concurrent build leaves an invalid index that is always
 * rebuilt. A valid index with an unexpected definition is rebuilt only for an
 * opted-in index that enforces no invariant; otherwise it is left in place
 * and the definition check fails the run.
 */
function shouldRebuildIndex(
  index: OperationalIndex,
  state: IndexState,
): boolean {
  if (!state.indisvalid || !state.indisready) return true;
  if (hasExpectedDefinition(index, state.definition)) return false;
  return index.repairDefinitionDrift === true && !state.enforcesInvariant;
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
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--managed-release")) {
      throw new Error("usage: ensure-operational-indexes.ts [--managed-release]");
    }
    const indexes = await ensureOperationalIndexes(getPool(), {
      managedRelease: args.includes("--managed-release"),
    });
    console.log(`operational indexes ready: ${indexes.join(", ")}`);
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
