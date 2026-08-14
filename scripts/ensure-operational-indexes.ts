import type { Pool, PoolClient } from "pg";

import { closeDb, getPool } from "@/lib/db";

const RELEASE_STEP = "operational-indexes-v5";
const RELEASE_LOCK_NAMESPACE = 1_349_481_332;
const RELEASE_LOCK_OPERATION = 1_768_704_356;
const RELEASE_LOCK_WAIT_MS = 15 * 60 * 1_000;
const RELEASE_LOCK_POLL_MS = 250;

interface OperationalIndex {
  name: string;
  createSql: string;
  unique: boolean;
  keyCount: number;
  definitionMd5: string;
  predicateMd5: string | null;
}

const OPERATIONAL_INDEXES: OperationalIndex[] = [
  {
    name: "reviews_running_started_at_idx",
    unique: false,
    keyCount: 1,
    definitionMd5: "b6839881243561fde8a8ca8cb80a2267",
    predicateMd5: "467d796d1480c40a33c0edb2c9495319",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "reviews_running_started_at_idx" ON "reviews" ("started_at") WHERE "status" = \'running\'',
  },
  {
    name: "jobs_running_locked_at_idx",
    unique: false,
    keyCount: 1,
    definitionMd5: "f5e95d29dbd992304b7e19985af402aa",
    predicateMd5: "caece85301b895614d0889e167cc71ef",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_running_locked_at_idx" ON "jobs" ("locked_at") WHERE "status" = \'running\'',
  },
  {
    name: "webhook_deliveries_completed_at_idx",
    unique: false,
    keyCount: 1,
    definitionMd5: "d6ee2bac3d0d7126d299077b9db6340f",
    predicateMd5: "9c957a1014417eae0c56ef68c7a42ce7",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_deliveries_completed_at_idx" ON "webhook_deliveries" ("completed_at") WHERE "completed_at" IS NOT NULL',
  },
  {
    name: "respond_deliveries_pr_identity_idx",
    unique: false,
    keyCount: 4,
    definitionMd5: "27d17286670fb225a7a48a020d618e70",
    predicateMd5: "31273e44e09f7e14228c853565632e50",
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "respond_deliveries_pr_identity_idx" ON "respond_deliveries" ("source_github_installation_id", "source_github_repo_id", "issue_number", "source_head_sha") WHERE "is_pr" AND "state" IN (\'prepared\', \'delivering\')',
  },
  {
    name: "finding_approvals_github_comment_idx",
    unique: true,
    keyCount: 4,
    definitionMd5: "b239c01f172372a1dbab150e1c98f708",
    predicateMd5: "e0a83a42fa4f6d568b906f37baacbb89",
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "finding_approvals_github_comment_idx" ON "finding_approvals" ("source_github_installation_id", "source_github_repo_id", "source_comment_kind", "source_github_comment_id") WHERE "source" = \'github\'',
  },
  {
    name: "finding_approvals_github_delivery_idx",
    unique: true,
    keyCount: 1,
    definitionMd5: "291900fab417c3c7b54c308c2080d124",
    predicateMd5: "e0a83a42fa4f6d568b906f37baacbb89",
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "finding_approvals_github_delivery_idx" ON "finding_approvals" ("source_webhook_delivery_id") WHERE "source" = \'github\'',
  },
  {
    name: "finding_lifecycle_observations_review_idx",
    unique: false,
    keyCount: 1,
    definitionMd5: "c5a23c5efc99023a32001bfe7318c723",
    predicateMd5: null,
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "finding_lifecycle_observations_review_idx" ON "finding_lifecycle_observations" ("review_id")',
  },
  {
    name: "jobs_active_review_identity_idx",
    unique: true,
    keyCount: 3,
    definitionMd5: "6951fb498740a630eccb379a21f9cce2",
    predicateMd5: "761f374eab49d7495d52daba45dee665",
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "jobs_active_review_identity_idx" ON "jobs" ((CASE WHEN "payload"->>\'githubRepoId\' ~ \'^[1-9][0-9]*$\' AND (length("payload"->>\'githubRepoId\') < 19 OR (length("payload"->>\'githubRepoId\') = 19 AND "payload"->>\'githubRepoId\' <= \'9223372036854775807\')) THEN ("payload"->>\'githubRepoId\')::bigint END), (CASE WHEN "payload"->>\'prNumber\' ~ \'^[1-9][0-9]*$\' AND (length("payload"->>\'prNumber\') < 10 OR (length("payload"->>\'prNumber\') = 10 AND "payload"->>\'prNumber\' <= \'2147483647\')) THEN ("payload"->>\'prNumber\')::integer END), ("payload"->>\'headSha\')) WHERE "kind" = \'review\' AND "status" IN (\'queued\', \'running\') AND jsonb_typeof("payload"->\'githubRepoId\') = \'number\' AND "payload"->>\'githubRepoId\' ~ \'^[1-9][0-9]*$\' AND (length("payload"->>\'githubRepoId\') < 19 OR (length("payload"->>\'githubRepoId\') = 19 AND "payload"->>\'githubRepoId\' <= \'9223372036854775807\')) AND jsonb_typeof("payload"->\'prNumber\') = \'number\' AND "payload"->>\'prNumber\' ~ \'^[1-9][0-9]*$\' AND (length("payload"->>\'prNumber\') < 10 OR (length("payload"->>\'prNumber\') = 10 AND "payload"->>\'prNumber\' <= \'2147483647\')) AND jsonb_typeof("payload"->\'headSha\') = \'string\' AND length("payload"->>\'headSha\') BETWEEN 1 AND 200',
  },
];

const ACTIVE_REVIEW_SERIALIZATION_SQL = String.raw`
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'postil:active-review:' || repository_identity || chr(31) ||
      (NEW.payload->>'prNumber') || chr(31) || (NEW.payload->>'headSha'),
      0
    )
  );
`;

const SERIALIZED_ACTIVE_REVIEW_IDENTITY_TRIGGER_SQL = String.raw`
CREATE OR REPLACE FUNCTION suppress_duplicate_active_review_job()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  repository_identity text;
BEGIN
  IF NEW.kind <> 'review' OR NEW.status NOT IN ('queued', 'running') THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.payload->'githubRepoId') = 'number'
    AND NEW.payload->>'githubRepoId' ~ '^[1-9][0-9]*$'
    AND (
      length(NEW.payload->>'githubRepoId') < 19
      OR (
        length(NEW.payload->>'githubRepoId') = 19
        AND NEW.payload->>'githubRepoId' <= '9223372036854775807'
      )
    ) THEN
    repository_identity := NEW.payload->>'githubRepoId';
  ELSE
    SELECT repository.github_repo_id::text
      INTO repository_identity
      FROM repositories repository
     WHERE repository.full_name = NEW.payload->>'repoFullName'
     LIMIT 1;
  END IF;

  IF (
    repository_identity IS NOT NULL
    AND jsonb_typeof(NEW.payload->'prNumber') = 'number'
    AND NEW.payload->>'prNumber' ~ '^[1-9][0-9]*$'
    AND (
      length(NEW.payload->>'prNumber') < 10
      OR (
        length(NEW.payload->>'prNumber') = 10
        AND NEW.payload->>'prNumber' <= '2147483647'
      )
    )
    AND jsonb_typeof(NEW.payload->'headSha') = 'string'
    AND length(NEW.payload->>'headSha') BETWEEN 1 AND 200
  ) IS NOT TRUE THEN
    NEW.status := 'failed';
    NEW.locked_at := NULL;
    NEW.locked_by := NULL;
    NEW.last_error := 'active review identity is invalid';
    NEW.run_after := clock_timestamp();
    RETURN NEW;
  END IF;

  IF (NEW.payload->>'githubRepoId' = repository_identity) IS NOT TRUE THEN
    NEW.payload := jsonb_set(
      NEW.payload,
      '{githubRepoId}',
      to_jsonb(repository_identity::bigint),
      true
    );
  END IF;

${ACTIVE_REVIEW_SERIALIZATION_SQL}

  IF EXISTS (
    SELECT 1
      FROM jobs existing
     WHERE existing.kind = 'review'
       AND existing.status IN ('queued', 'running')
       AND existing.id IS DISTINCT FROM NEW.id
       AND existing.payload->>'githubRepoId' = repository_identity
       AND existing.payload->>'prNumber' = NEW.payload->>'prNumber'
       AND existing.payload->>'headSha' = NEW.payload->>'headSha'
  ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END $$;
`;

const NONLOCKING_ACTIVE_REVIEW_IDENTITY_TRIGGER_SQL =
  SERIALIZED_ACTIVE_REVIEW_IDENTITY_TRIGGER_SQL.replace(
    ACTIVE_REVIEW_SERIALIZATION_SQL,
    "",
  );

interface IndexState {
  indisvalid: boolean;
  indisready: boolean;
  indisunique: boolean;
  indnkeyatts: number;
  definition_md5: string;
  predicate_md5: string | null;
}

export async function ensureOperationalIndexes(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  let locked = false;
  try {
    await acquireReleaseLock(client);
    locked = true;
    await ensureReleaseStepsTable(client);
    await installValidatedActiveReviewIdentityTrigger(client);
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
    await installNonlockingActiveReviewIdentityTrigger(client);

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

async function installValidatedActiveReviewIdentityTrigger(
  client: PoolClient,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query('LOCK TABLE "jobs" IN SHARE ROW EXCLUSIVE MODE');
    await client.query(SERIALIZED_ACTIVE_REVIEW_IDENTITY_TRIGGER_SQL);
    const result = await client.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'suppress_duplicate_active_review_job()'::regprocedure
       ) AS definition`,
    );
    const definition = result.rows[0]?.definition ?? "";
    if (
      !definition.includes("pg_advisory_xact_lock") ||
      !definition.includes("active review identity is invalid")
    ) {
      throw new Error("active review identity trigger has an unexpected definition");
    }
    await assertActiveReviewIdentities(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function assertActiveReviewIdentities(client: PoolClient): Promise<void> {
  const result = await client.query<{ invalid_count: string }>(
    `SELECT count(*)::text AS invalid_count
       FROM jobs
      WHERE kind = 'review'
        AND status IN ('queued', 'running')
        AND (
          jsonb_typeof(payload->'githubRepoId') = 'number'
          AND payload->>'githubRepoId' ~ '^[1-9][0-9]*$'
          AND (
            length(payload->>'githubRepoId') < 19
            OR (
              length(payload->>'githubRepoId') = 19
              AND payload->>'githubRepoId' <= '9223372036854775807'
            )
          )
          AND jsonb_typeof(payload->'prNumber') = 'number'
          AND payload->>'prNumber' ~ '^[1-9][0-9]*$'
          AND (
            length(payload->>'prNumber') < 10
            OR (
              length(payload->>'prNumber') = 10
              AND payload->>'prNumber' <= '2147483647'
            )
          )
          AND jsonb_typeof(payload->'headSha') = 'string'
          AND length(payload->>'headSha') BETWEEN 1 AND 200
        ) IS NOT TRUE`,
  );
  if (Number(result.rows[0]?.invalid_count ?? 0) !== 0) {
    throw new Error("active review jobs contain an invalid typed identity");
  }
}

async function installNonlockingActiveReviewIdentityTrigger(
  client: PoolClient,
): Promise<void> {
  await client.query(NONLOCKING_ACTIVE_REVIEW_IDENTITY_TRIGGER_SQL);
  const result = await client.query<{ definition: string }>(
    `SELECT pg_get_functiondef(
       'suppress_duplicate_active_review_job()'::regprocedure
     ) AS definition`,
  );
  const definition = result.rows[0]?.definition ?? "";
  if (
    definition.includes("pg_advisory_xact_lock") ||
    !definition.includes("active review identity is invalid")
  ) {
    throw new Error("active review identity trigger has an unexpected definition");
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
            pg_index.indisunique,
            pg_index.indnkeyatts,
            md5(pg_get_indexdef(pg_index.indexrelid)) AS definition_md5,
            md5(pg_get_expr(pg_index.indpred, pg_index.indrelid, true)) AS predicate_md5
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
  if (state.indisunique !== index.unique || state.indnkeyatts !== index.keyCount) {
    throw new Error(`operational index ${index.name} has an unexpected definition`);
  }
  if (
    state.definition_md5 !== index.definitionMd5 ||
    state.predicate_md5 !== index.predicateMd5
  ) {
    throw new Error(`operational index ${index.name} has an unexpected definition`);
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
