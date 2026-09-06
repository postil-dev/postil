import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { Database } from "@/lib/db";
import { withPinnedDatabaseTransaction } from "@/lib/db-transaction";
import {
  lockPublicationLifecycleShared,
  PUBLICATION_LIFECYCLE_LOCK,
} from "@/lib/publication-lifecycle-lock";
import { OPENROUTER_EXACT_LIMIT_MAX_MICROS } from "@/lib/openrouter-management-adapter";
import {
  HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
  type HostedProviderKeyLifecycleJobPayload,
} from "@/lib/queue";
import { HOSTED_REVIEW_UNAVAILABLE_MESSAGE } from "@/lib/review-outcome";

export const RELEASE_V1_JOB_KINDS = [
  "billing-contact-verification",
  "respond-delivery",
  "webhook-comment",
] as const;

export const RELEASE_V1_JOBS_CAPABILITY = "release-v1-jobs";
const ADVISORY_LOCK_NAME = "postil:release-v1-jobs";
export const PRIVATE_REVIEW_AUTHOR_CAPABILITY = "private-review-author-v1";
const PRIVATE_REVIEW_AUTHOR_LOCK = "postil:private-review-author-v1";
const HOSTED_INFERENCE_CAPABILITY_PREFIX = "hosted-inference-release:";
const HOSTED_INFERENCE_DARK_PREFIX = "hosted-inference-dark:";
const MANAGED_RELEASE_PREPARATION_PREFIX = "managed-release-preparation:";
const MANAGED_RELEASE_PROTOCOL_PREFIX = "managed-release-protocol:";
export const COMPATIBLE_MANAGED_RELEASE_PROTOCOL =
  "additive-publication-hosted-v1";
export const COMPATIBLE_MANAGED_RELEASE_BOOTSTRAP_SHA =
  "35dd695af19e817bd7b87be5be808b45cefaa7a7";
export const HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY =
  "hosted-inference-fleet-active";
export const HOSTED_INFERENCE_LOCK = "postil:hosted-inference-release";
export const PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY =
  "publication-lifecycle-fleet-active";
const PUBLICATION_LIFECYCLE_DARK_PAYLOAD_KEY =
  "_postilPublicationLifecycleDark";
const PUBLICATION_LIFECYCLE_LOCK_TIMEOUT_MS = 30_000;
const LEGACY_PUBLICATION_DRAIN_TIMEOUT_MS = 120_000;
const COMPATIBLE_RELEASE_LOCK_TIMEOUT = "5s";
const COMPATIBLE_RELEASE_STATEMENT_TIMEOUT = "30s";

function databaseClientError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

async function lockPublicationLifecycleExclusive(
  client: PoolClient,
): Promise<void> {
  const configuredLockTimeout = await client.query<{ lock_timeout: string }>(
    "SHOW lock_timeout",
  );
  const lockTimeout = configuredLockTimeout.rows[0]?.lock_timeout;
  if (lockTimeout === undefined) {
    throw new Error(
      "publication lifecycle lock timeout configuration is unavailable",
    );
  }
  await client.query("SAVEPOINT publication_lifecycle_lock_attempt");
  try {
    // Keep one exclusive request continuously queued. Trigger try-locks then
    // defer new producers without a polling gap that could starve the drain.
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${PUBLICATION_LIFECYCLE_LOCK_TIMEOUT_MS}ms`,
    ]);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PUBLICATION_LIFECYCLE_LOCK],
    );
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      lockTimeout,
    ]);
    await client.query("RELEASE SAVEPOINT publication_lifecycle_lock_attempt");
  } catch (error) {
    try {
      await client.query("ROLLBACK TO SAVEPOINT publication_lifecycle_lock_attempt");
      await client.query("RELEASE SAVEPOINT publication_lifecycle_lock_attempt");
    } catch (cleanupError) {
      throw new AggregateError(
        [
          databaseClientError(error, "publication lifecycle lock attempt failed"),
          databaseClientError(
            cleanupError,
            "publication lifecycle lock savepoint cleanup failed",
          ),
        ],
        "publication lifecycle lock attempt and savepoint cleanup failed",
      );
    }
    if ((error as { code?: string }).code === "55P03") {
      throw new Error(
        "publication lifecycle lock did not quiesce within 30 seconds",
      );
    }
    throw error;
  }
}

async function waitForLegacyPublicationLifecycleOperations(
  client: PoolClient,
): Promise<void> {
  const deadline = Date.now() + LEGACY_PUBLICATION_DRAIN_TIMEOUT_MS;
  while (true) {
    const active = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM jobs
          WHERE kind = 'gate-state-sync'
            AND status = 'running'
       ) OR EXISTS (
         SELECT 1 FROM reviews
          WHERE gate_sync_lease_id IS NOT NULL
            AND gate_sync_lease_expires_at >= clock_timestamp()
       ) AS active`,
    );
    if (active.rows[0]?.active !== true) return;
    if (Date.now() >= deadline) {
      throw new Error(
        "legacy publication lifecycle operations did not quiesce within 120 seconds",
      );
    }
    await client.query("SELECT pg_sleep(0.1)");
  }
}

export class PublicationLifecycleReleaseDarkError extends Error {
  override name = "PublicationLifecycleReleaseDarkError";

  constructor() {
    super("publication lifecycle release is awaiting activation");
  }
}

export async function publicationLifecycleReleaseActivated(
  pool: Pool,
): Promise<boolean> {
  const result = await pool.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS active`,
    [PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY],
  );
  return result.rows[0]?.active === true;
}

/** Keep gate publication inside the active lifecycle release boundary. */
export async function withPublicationLifecycleReleaseActive<T>(
  pool: Pool,
  operation: (db: Database, client: PoolClient) => Promise<T>,
): Promise<T> {
  return withPinnedDatabaseTransaction(
    pool,
    "publication lifecycle gate",
    async (transaction, client) => {
      // Use one transaction for the release lock, leases, nested job staging,
      // and convergence writes. Trigger lock requests are then reentrant on
      // the same backend even when deactivation is already waiting.
      await lockPublicationLifecycleShared(transaction);
      const active = await client.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM deployment_capabilities WHERE name = $1
         ) AS active`,
        [PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY],
      );
      if (active.rows[0]?.active !== true) {
        throw new PublicationLifecycleReleaseDarkError();
      }
      return operation(transaction, client);
    },
  );
}

/** Park every gate while a mixed-version fleet can still enqueue old work. */
export async function deactivatePublicationLifecycleRelease(
  pool: Pool,
): Promise<{ deactivated: boolean; parked: number }> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  let transactionOpen = false;
  try {
    // Managed release preparation records a durable recovery journal before
    // this drain begins. The first commit removes the active capability, so
    // the database trigger parks every new gate job before the exclusive lock
    // is requested. Admitted legacy operations can then drain without a gap
    // that lets another active publisher enter; interruption remains
    // fail-closed and recoverable.
    await client.query("BEGIN");
    transactionOpen = true;
    const initial = await darkenPublicationLifecycle(client);
    await client.query("COMMIT");
    transactionOpen = false;

    await client.query("BEGIN");
    transactionOpen = true;
    await waitForLegacyPublicationLifecycleOperations(client);
    await lockPublicationLifecycleExclusive(client);
    const fenced = await darkenPublicationLifecycle(client);
    await client.query("COMMIT");
    transactionOpen = false;
    return {
      deactivated: initial.deactivated || fenced.deactivated,
      parked: initial.parked + fenced.parked,
    };
  } catch (error) {
    const primaryError = databaseClientError(
      error,
      "publication lifecycle deactivation failed",
    );
    if (!transactionOpen) {
      // A failed BEGIN leaves the backend state uncertain. Do not return that
      // client to the pool where a later operation could inherit the failure.
      releaseError = primaryError;
      throw primaryError;
    }
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = databaseClientError(
          rollbackError,
          "publication lifecycle deactivation rollback failed",
        );
        throw new AggregateError(
          [
            primaryError,
            releaseError,
          ],
          "publication lifecycle deactivation and rollback failed",
        );
      }
    }
    // A successful rollback leaves the client reusable. releaseError is set
    // only when BEGIN or rollback leaves the backend state uncertain.
    throw primaryError;
  } finally {
    client.release(releaseError);
  }
}

async function darkenPublicationLifecycle(
  client: PoolClient,
): Promise<{ deactivated: boolean; parked: number }> {
  const deactivated = await client.query(
    "DELETE FROM deployment_capabilities WHERE name = $1",
    [PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY],
  );
  const parked = await client.query(
    `UPDATE jobs
        SET run_after = 'infinity'::timestamptz,
            payload = jsonb_set(
              payload,
              ARRAY[$1]::text[],
              'true'::jsonb,
              true
            )
      WHERE kind = 'gate-state-sync'
        AND status = 'queued'
        AND (
          run_after <> 'infinity'::timestamptz
          OR NOT (payload ? $1)
        )`,
    [PUBLICATION_LIFECYCLE_DARK_PAYLOAD_KEY],
  );
  return {
    deactivated: (deactivated.rowCount ?? 0) > 0,
    parked: parked.rowCount ?? 0,
  };
}

/** Queue mixed-fleet recovery and release gates after homogeneous-fleet proof. */
export async function activatePublicationLifecycleRelease(
  pool: Pool,
): Promise<{
  activated: boolean;
  recoveriesQueued: number;
  runningGatesRecovered: number;
  released: number;
}> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await lockPublicationLifecycleExclusive(client);
    const invalid = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM reviews AS review
         LEFT JOIN repositories AS repository
           ON repository.id = review.repository_id
         LEFT JOIN installations AS installation
           ON installation.id = repository.installation_id
        WHERE review.status = 'completed'
          AND review.publication_lifecycle_required_at IS NOT NULL
          AND review.publication_lifecycle_reconciled_at IS NULL
          AND (
            review.envelope IS NULL
            OR review.finished_at IS NULL
            OR review.advisory_check_run_id IS NULL
            OR review.gate_check_run_id IS NULL
            OR review.source_org_id IS NULL
            OR review.source_installation_id IS NULL
            OR review.source_github_installation_id IS NULL
            OR review.source_github_repo_id IS NULL
            OR review.source_repo_full_name IS NULL
            OR installation.id IS NULL
            OR review.source_org_id IS DISTINCT FROM installation.org_id
            OR review.source_installation_id IS DISTINCT FROM installation.id
            OR review.source_github_installation_id IS DISTINCT FROM installation.github_installation_id
            OR review.source_github_repo_id IS DISTINCT FROM repository.github_repo_id
            OR review.source_repo_full_name IS DISTINCT FROM repository.full_name
            OR NOT EXISTS (
              SELECT 1 FROM review_publication_receipts AS receipt
               WHERE receipt.review_id = review.id
            )
          )`,
    );
    const invalidCount = Number(invalid.rows[0]?.count ?? "0");
    if (invalidCount > 0) {
      throw new Error(
        `publication lifecycle activation found ${invalidCount} unrecoverable completed reviews`,
      );
    }
    const recoveries = await client.query(
      `INSERT INTO jobs (kind, payload, max_attempts)
       SELECT
         'review',
         jsonb_strip_nulls(jsonb_build_object(
           'installationId', review.source_github_installation_id,
           'sourceInstallationId', review.source_installation_id,
           'sourceOrgId', review.source_org_id,
           'githubRepoId', review.source_github_repo_id,
           'repoFullName', review.source_repo_full_name,
           'repositoryPrivate', repository.private,
           'prNumber', review.pr_number,
           'authorGithubId', review.author_github_id,
           'authorLogin', review.author_login,
           'headSha', review.head_sha,
           'baseSha', review.base_sha,
           'trigger', COALESCE(
             review.trigger_context,
             jsonb_build_object('source', review.trigger_source)
           ),
           'recoveryReviewId', review.id
         )),
         5
       FROM reviews AS review
       INNER JOIN repositories AS repository
         ON repository.id = review.repository_id
       WHERE review.status = 'completed'
         AND review.publication_lifecycle_required_at IS NOT NULL
         AND review.publication_lifecycle_reconciled_at IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM jobs AS active_recovery
            WHERE active_recovery.kind = 'review'
              AND active_recovery.status IN ('queued', 'running')
              AND active_recovery.payload->>'recoveryReviewId' = review.id::text
         )`,
    );
    const activated = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY],
    );
    const runningGates = (activated.rowCount ?? 0) > 0
      ? await client.query(
          `UPDATE jobs
              SET status = 'queued',
                  locked_at = NULL,
                  locked_by = NULL,
                  run_after = now(),
                  payload = payload - $1,
                  last_error = concat_ws(
                    ' ', NULLIF(last_error, ''),
                    '[release: recovered abandoned gate publisher]'
                  )
            WHERE kind = 'gate-state-sync'
              AND status = 'running'`,
          [PUBLICATION_LIFECYCLE_DARK_PAYLOAD_KEY],
        )
      : { rowCount: 0 };
    const released = await client.query(
      `UPDATE jobs
          SET run_after = now(), payload = payload - $1
        WHERE kind = 'gate-state-sync'
          AND status = 'queued'
          AND payload ? $1`,
      [PUBLICATION_LIFECYCLE_DARK_PAYLOAD_KEY],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return {
      activated: (activated.rowCount ?? 0) > 0,
      recoveriesQueued: recoveries.rowCount ?? 0,
      runningGatesRecovered: runningGates.rowCount ?? 0,
      released: released.rowCount ?? 0,
    };
  } catch (error) {
    const primaryError = databaseClientError(
      error,
      "publication lifecycle activation failed",
    );
    if (!transactionOpen) {
      releaseError = primaryError;
      throw primaryError;
    }
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = databaseClientError(
        rollbackError,
        "publication lifecycle activation rollback failed",
      );
      throw new AggregateError(
        [primaryError, releaseError],
        "publication lifecycle activation and rollback failed",
      );
    }
    // A successful rollback leaves the client reusable. releaseError is set
    // only when BEGIN or rollback leaves the backend state uncertain.
    throw primaryError;
  } finally {
    client.release(releaseError);
  }
}

function normalizedReleaseSha(releaseSha: string): string {
  const normalized = releaseSha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(normalized)) {
    throw new Error("hosted inference activation requires a release SHA");
  }
  return normalized;
}

function normalizedManagedReleaseSha(releaseSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
    throw new Error(
      "managed release compatibility requires an exact lowercase release SHA",
    );
  }
  return releaseSha;
}

export interface ManagedReleaseMigrationIdentity {
  folderMillis: number;
  hash: string;
}

function requireCompatibleManagedReleaseProtocol(protocol: string): void {
  if (protocol !== COMPATIBLE_MANAGED_RELEASE_PROTOCOL) {
    throw new Error(
      `managed release protocol must be ${COMPATIBLE_MANAGED_RELEASE_PROTOCOL}`,
    );
  }
}

export function compatibleManagedReleaseProtocolCapability(
  releaseSha: string,
): string {
  return `${MANAGED_RELEASE_PROTOCOL_PREFIX}${normalizedManagedReleaseSha(releaseSha)}:${COMPATIBLE_MANAGED_RELEASE_PROTOCOL}`;
}

async function assertExactManagedReleaseMigrations(
  client: PoolClient,
  expected: readonly ManagedReleaseMigrationIdentity[],
): Promise<void> {
  if (
    expected.length === 0 ||
    expected.some(
      (migration) =>
        !Number.isSafeInteger(migration.folderMillis) ||
        migration.folderMillis <= 0 ||
        !/^[0-9a-f]{64}$/.test(migration.hash),
    )
  ) {
    throw new Error("checked-in managed release migration identities are invalid");
  }
  const expectedByCreatedAt = new Map(
    expected.map((migration) => [String(migration.folderMillis), migration]),
  );
  if (expectedByCreatedAt.size !== expected.length) {
    throw new Error("checked-in managed release migration identities are invalid");
  }
  const table = await client.query<{ present: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (table.rows[0]?.present !== true) {
    throw new Error("managed release migration journal is missing");
  }
  const actual = await client.query<{ hash: string; created_at: string }>(
    `SELECT hash, created_at::text
       FROM drizzle.__drizzle_migrations`,
  );
  const actualByCreatedAt = new Map<string, string>();
  const unknown = actual.rows.some((migration) => {
    if (
      !expectedByCreatedAt.has(migration.created_at) ||
      actualByCreatedAt.has(migration.created_at)
    ) {
      return true;
    }
    actualByCreatedAt.set(migration.created_at, migration.hash);
    return false;
  });
  if (unknown) {
    throw new Error(
      "managed release migration journal has unknown migrations " +
        `(database=${actual.rows.length}, checked_in=${expected.length})`,
    );
  }
  if (actualByCreatedAt.size < expectedByCreatedAt.size) {
    throw new Error(
      "managed release migration journal has pending migrations " +
        `(database=${actual.rows.length}, checked_in=${expected.length})`,
    );
  }
  for (const [createdAt, wanted] of expectedByCreatedAt) {
    if (actualByCreatedAt.get(createdAt) !== wanted.hash) {
      throw new Error(
        `managed release migration journal mismatch at ${createdAt}`,
      );
    }
  }
}

async function assertCompatibleManagedReleaseDatabaseState(
  client: PoolClient,
  sourceReleaseSha: string,
  releaseSha: string,
  migrations: readonly ManagedReleaseMigrationIdentity[],
  requirePreparedRelease: boolean,
): Promise<{ bootstrap: boolean }> {
  await assertExactManagedReleaseMigrations(client, migrations);
  const sourceCapability = hostedInferenceCapability(sourceReleaseSha);
  const targetCapability = hostedInferenceCapability(releaseSha);
  const sourceProtocolCapability =
    compatibleManagedReleaseProtocolCapability(sourceReleaseSha);
  const targetProtocolCapability =
    compatibleManagedReleaseProtocolCapability(releaseSha);
  const state = await client.query<{
    publication_active: boolean;
    hosted_fleet_active: boolean;
    release_jobs_active: boolean;
    private_review_author_active: boolean;
    hosted_release_active: boolean;
    source_release_active: boolean;
    target_release_active: boolean;
    source_protocol_active: boolean;
    target_protocol_active: boolean;
    preparation_pending: boolean;
    hosted_dark: boolean;
    protocols: string[];
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM deployment_capabilities WHERE name = $1)
         AS publication_active,
       EXISTS (SELECT 1 FROM deployment_capabilities WHERE name = $2)
         AS hosted_fleet_active,
       EXISTS (SELECT 1 FROM deployment_capabilities WHERE name = $3)
         AS release_jobs_active,
       EXISTS (SELECT 1 FROM deployment_capabilities WHERE name = $4)
         AS private_review_author_active,
       EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name LIKE $5
       ) AS hosted_release_active,
       EXISTS (SELECT 1 FROM deployment_capabilities WHERE name = $6)
         AS source_release_active,
       EXISTS (SELECT 1 FROM deployment_capabilities WHERE name = $7)
         AS target_release_active,
       EXISTS (SELECT 1 FROM deployment_capabilities WHERE name = $8)
         AS source_protocol_active,
       EXISTS (SELECT 1 FROM deployment_capabilities WHERE name = $9)
         AS target_protocol_active,
       EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name LIKE $10
       ) AS preparation_pending,
       EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name LIKE $11
       ) AS hosted_dark,
       ARRAY(
         SELECT name FROM deployment_capabilities
          WHERE name LIKE $12
          ORDER BY name
       ) AS protocols`,
    [
      PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY,
      HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY,
      RELEASE_V1_JOBS_CAPABILITY,
      PRIVATE_REVIEW_AUTHOR_CAPABILITY,
      `${HOSTED_INFERENCE_CAPABILITY_PREFIX}%`,
      sourceCapability,
      targetCapability,
      sourceProtocolCapability,
      targetProtocolCapability,
      `${MANAGED_RELEASE_PREPARATION_PREFIX}%`,
      `${HOSTED_INFERENCE_DARK_PREFIX}%`,
      `${MANAGED_RELEASE_PROTOCOL_PREFIX}%`,
    ],
  );
  const observed = state.rows[0];
  if (
    !observed?.publication_active ||
    !observed.hosted_fleet_active ||
    !observed.release_jobs_active ||
    !observed.private_review_author_active
  ) {
    throw new Error("managed release requires every active baseline capability");
  }
  if (!observed.hosted_release_active) {
    throw new Error("managed release requires an active hosted release capability");
  }
  if (observed.preparation_pending || observed.hosted_dark) {
    throw new Error("managed release requires no preparation journal or hosted dark capability");
  }
  const compatibleProtocolPattern = new RegExp(
    `^${MANAGED_RELEASE_PROTOCOL_PREFIX}[0-9a-f]{40}:${COMPATIBLE_MANAGED_RELEASE_PROTOCOL}$`,
  );
  if (observed.protocols.some((name) => !compatibleProtocolPattern.test(name))) {
    throw new Error("managed release database has an incompatible protocol capability");
  }
  const bootstrap = observed.protocols.length === 0;
  if (bootstrap && sourceReleaseSha !== COMPATIBLE_MANAGED_RELEASE_BOOTSTRAP_SHA) {
    throw new Error(
      "managed release protocol bootstrap requires the known live fleet release",
    );
  }
  if (!observed.source_release_active) {
    throw new Error("managed release source hosted capability is not active");
  }
  if (!bootstrap && !observed.source_protocol_active) {
    throw new Error("managed release source protocol capability is missing");
  }
  if (
    requirePreparedRelease &&
    (!observed.target_protocol_active || !observed.target_release_active)
  ) {
    throw new Error("managed release exact capability is not prepared");
  }
  return { bootstrap };
}

async function withCompatibleManagedReleaseState<T>(
  pool: Pool,
  sourceReleaseSha: string,
  releaseSha: string,
  protocol: string,
  migrations: readonly ManagedReleaseMigrationIdentity[],
  options: {
    readOnly: boolean;
    requirePreparedRelease: boolean;
    lockLifecycle: boolean;
  },
  operation: (
    client: PoolClient,
    state: { bootstrap: boolean },
  ) => Promise<T>,
): Promise<T> {
  requireCompatibleManagedReleaseProtocol(protocol);
  const normalizedSourceRelease = normalizedManagedReleaseSha(sourceReleaseSha);
  const normalizedRelease = normalizedManagedReleaseSha(releaseSha);
  const client = await pool.connect();
  try {
    await client.query(
      options.readOnly
        ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
        : "BEGIN",
    );
    await client.query(
      `SELECT
         set_config('lock_timeout', $1, true),
         set_config('statement_timeout', $2, true)`,
      [COMPATIBLE_RELEASE_LOCK_TIMEOUT, COMPATIBLE_RELEASE_STATEMENT_TIMEOUT],
    );
    if (options.lockLifecycle) {
      const publicationLock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1, 0)) AS locked",
        [PUBLICATION_LIFECYCLE_LOCK],
      );
      if (publicationLock.rows[0]?.locked !== true) {
        throw new Error("managed release publication lifecycle lock is busy");
      }
      const hostedLock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked",
        [HOSTED_INFERENCE_LOCK],
      );
      if (hostedLock.rows[0]?.locked !== true) {
        throw new Error("managed release hosted lifecycle lock is busy");
      }
    }
    const state = await assertCompatibleManagedReleaseDatabaseState(
      client,
      normalizedSourceRelease,
      normalizedRelease,
      migrations,
      options.requirePreparedRelease,
    );
    const result = await operation(client, state);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Verify rolling compatibility without changing release availability. */
export async function verifyCompatibleManagedRelease(
  pool: Pool,
  sourceReleaseSha: string,
  releaseSha: string,
  protocol: string,
  migrations: readonly ManagedReleaseMigrationIdentity[],
): Promise<void> {
  await withCompatibleManagedReleaseState(
    pool,
    sourceReleaseSha,
    releaseSha,
    protocol,
    migrations,
    { readOnly: true, requirePreparedRelease: false, lockLifecycle: false },
    async () => undefined,
  );
}

/** Add only the reviewed protocol identity and exact new release capability. */
export async function prepareCompatibleManagedRelease(
  pool: Pool,
  sourceReleaseSha: string,
  releaseSha: string,
  protocol: string,
  migrations: readonly ManagedReleaseMigrationIdentity[],
): Promise<boolean> {
  return withCompatibleManagedReleaseState(
    pool,
    sourceReleaseSha,
    releaseSha,
    protocol,
    migrations,
    { readOnly: false, requirePreparedRelease: false, lockLifecycle: true },
    async (client, state) => {
      const protocolCapabilities = [
        compatibleManagedReleaseProtocolCapability(releaseSha),
        ...(state.bootstrap
          ? [compatibleManagedReleaseProtocolCapability(sourceReleaseSha)]
          : []),
      ];
      const inserted = await client.query(
        `INSERT INTO deployment_capabilities (name)
         SELECT unnest($1::text[])
         ON CONFLICT (name) DO NOTHING`,
        [
          [
            ...protocolCapabilities,
            hostedInferenceCapability(releaseSha),
          ],
        ],
      );
      return (inserted.rowCount ?? 0) > 0;
    },
  );
}

/** Verify the exact prepared release after homogeneous-fleet proof. */
export async function verifyPreparedCompatibleManagedRelease(
  pool: Pool,
  sourceReleaseSha: string,
  releaseSha: string,
  protocol: string,
  migrations: readonly ManagedReleaseMigrationIdentity[],
): Promise<void> {
  await withCompatibleManagedReleaseState(
    pool,
    sourceReleaseSha,
    releaseSha,
    protocol,
    migrations,
    { readOnly: true, requirePreparedRelease: true, lockLifecycle: false },
    async () => undefined,
  );
}

export function hostedInferenceCapability(releaseSha: string): string {
  return `${HOSTED_INFERENCE_CAPABILITY_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

function hostedInferenceDarkCapability(releaseSha: string): string {
  return `${HOSTED_INFERENCE_DARK_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

/** A managed worker claimed hosted work before its exact release was activated. */
export class HostedInferenceReleaseDarkError extends Error {
  override name = "HostedInferenceReleaseDarkError";

  constructor(readonly releaseSha: string) {
    super("managed hosted inference release is awaiting activation");
  }
}

/** True only after this exact managed release passes its fleet and provider preflight. */
export async function hostedInferenceReleaseActivated(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const result = await pool.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS active`,
    [hostedInferenceCapability(releaseSha)],
  );
  return result.rows[0]?.active === true;
}

/**
 * Hold the activation lock while one bounded managed-provider operation runs.
 * Deploy activation and deactivation take the same lock, so provider access
 * cannot cross a release-dark transition.
 */
export async function withHostedInferenceReleaseActive<T>(
  pool: Pool,
  releaseSha: string,
  operation: () => Promise<T>,
): Promise<T> {
  const capability = hostedInferenceCapability(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const active = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AND EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $2
       ) AS active`,
      [capability, HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY],
    );
    if (active.rows[0]?.active !== true) {
      throw new HostedInferenceReleaseDarkError(releaseSha);
    }
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Activate managed hosted inference for one exact release after its smoke test. */
export async function activateHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const capability = hostedInferenceCapability(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const activated = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [capability],
    );
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET activated_at = now()`,
      [HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY],
    );
    await client.query(
      `
      WITH candidates AS (
        SELECT grant_row.org_id
        FROM self_service_trial_grants grant_row
        JOIN organization_entitlements entitlement
          ON entitlement.org_id = grant_row.org_id
        LEFT JOIN org_settings settings
          ON settings.org_id = grant_row.org_id
        WHERE grant_row.requested_mode = 'hosted'
          AND grant_row.granted_mode = 'byok'
          AND entitlement.subscription_mode = 'byok'
          AND entitlement.status = 'trialing'
          AND entitlement.updated_by = 'self-service-trial'
          AND entitlement.trial_ends_at > now()
          AND settings.api_key_ciphertext IS NULL
      ), promoted AS (
        UPDATE organization_entitlements entitlement
        SET subscription_mode = 'hosted',
            updated_by = 'hosted-release-activation',
            updated_at = now()
        FROM candidates
        WHERE entitlement.org_id = candidates.org_id
          AND entitlement.subscription_mode = 'byok'
          AND entitlement.status = 'trialing'
          AND entitlement.updated_by = 'self-service-trial'
          AND entitlement.trial_ends_at > now()
        RETURNING entitlement.org_id
      )
      UPDATE self_service_trial_grants grant_row
      SET granted_mode = 'hosted'
      FROM promoted
      WHERE grant_row.org_id = promoted.org_id
        AND grant_row.requested_mode = 'hosted'
        AND grant_row.granted_mode = 'byok'
    `,
    );
    await enqueueHostedProviderKeyLifecycleBackfill(client, releaseSha);
    const dark = await client.query<{ activated_at: Date }>(
      `SELECT min(activated_at) AS activated_at
         FROM deployment_capabilities
        WHERE name LIKE $1`,
      [`${HOSTED_INFERENCE_DARK_PREFIX}%`],
    );
    const darkStartedAt = dark.rows[0]?.activated_at;
    if (darkStartedAt) {
      // Reconcile automatic review requests recorded as unavailable inside the
      // durable dark window. Revive only the exact source job, and only when no
      // active or completed same-head review owns inference or publication.
      await client.query(
        `WITH candidates AS (
           SELECT job.id
             FROM jobs AS job
             JOIN repositories AS repository
               ON repository.github_repo_id::text = job.payload->>'githubRepoId'
              AND repository.installation_id::text =
                  job.payload->>'sourceInstallationId'
             JOIN reviews AS paused
               ON paused.repository_id = repository.id
              AND paused.pr_number::text = job.payload->>'prNumber'
              AND paused.head_sha = job.payload->>'headSha'
              AND paused.status = 'failed'
              AND paused.error_message = $2
              AND paused.trigger_source = 'automatic_pull_request'
              AND paused.trigger_context->>'webhookDeliveryId' =
                  job.payload->>'sourceDeliveryId'
            WHERE job.kind = 'review'
              AND job.status = 'done'
              AND job.created_at >= $1
              AND paused.finished_at >= $1
              AND job.payload#>>'{trigger,source}' = 'automatic_pull_request'
              AND NOT EXISTS (
                SELECT 1
                  FROM reviews AS owner
                 WHERE owner.repository_id = paused.repository_id
                   AND owner.pr_number = paused.pr_number
                   AND owner.head_sha = paused.head_sha
                   AND owner.status IN ('queued', 'running', 'completed')
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM jobs AS active
                 WHERE active.kind = 'review'
                   AND active.status IN ('queued', 'running')
                   AND active.id <> job.id
                   AND active.payload->>'githubRepoId' = job.payload->>'githubRepoId'
                   AND active.payload->>'prNumber' = job.payload->>'prNumber'
                   AND active.payload->>'headSha' = job.payload->>'headSha'
              )
            FOR UPDATE OF job SKIP LOCKED
         )
         UPDATE jobs AS job
            SET status = 'queued', attempts = 0, run_after = now(),
                locked_at = NULL, locked_by = NULL, last_error = NULL
           FROM candidates
          WHERE job.id = candidates.id`,
        [darkStartedAt, HOSTED_REVIEW_UNAVAILABLE_MESSAGE],
      );
    }
    await client.query(
      `UPDATE jobs
          SET run_after = now(),
              payload = payload - 'releaseDarkSha'
        WHERE kind IN ('review', $1)
          AND status = 'queued'
          AND run_after = 'infinity'::timestamptz
          AND payload ? 'releaseDarkSha'`,
      [HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND],
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE $1",
      [`${HOSTED_INFERENCE_DARK_PREFIX}%`],
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE $1",
      [`${MANAGED_RELEASE_PREPARATION_PREFIX}%`],
    );
    await client.query("COMMIT");
    return (activated.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Deploy and rollback preparation always make the target release dark first. */
export async function deactivateHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const capability = hostedInferenceCapability(releaseSha);
  const darkCapability = hostedInferenceDarkCapability(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const result = await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [capability],
    );
    await client.query("DELETE FROM deployment_capabilities WHERE name = $1", [
      HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY,
    ]);
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [darkCapability],
    );
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface ManagedReleaseCapabilitySnapshot {
  releaseSha: string;
  generation: string;
  publicationLifecycleReady: boolean;
  capabilities: string[];
}

function managedReleaseCapabilityNames(releaseSha: string): string[] {
  return [
    PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY,
    HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY,
    hostedInferenceCapability(releaseSha),
    hostedInferenceDarkCapability(releaseSha),
  ];
}

function managedReleasePreparationNames(
  releaseSha: string,
  generation: string,
): {
  root: string;
  publicationReady: string;
  publicationActive: string;
  hostedFleetActive: string;
  hostedReleaseActive: string;
  hostedDarkActive: string;
} {
  const prefix = `${MANAGED_RELEASE_PREPARATION_PREFIX}${releaseSha}:${generation}:`;
  return {
    root: `${prefix}root`,
    publicationReady: `${prefix}publication-ready`,
    publicationActive: `${prefix}publication-active`,
    hostedFleetActive: `${prefix}hosted-fleet-active`,
    hostedReleaseActive: `${prefix}hosted-release-active`,
    hostedDarkActive: `${prefix}hosted-dark-active`,
  };
}

function managedReleasePreparationSnapshot(
  releaseSha: string,
  generation: string,
  names: readonly string[],
): ManagedReleaseCapabilitySnapshot | undefined {
  const journal = managedReleasePreparationNames(releaseSha, generation);
  const present = new Set(names);
  if (!present.has(journal.root)) return undefined;
  const capabilities: string[] = [];
  if (present.has(journal.publicationActive)) {
    capabilities.push(PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY);
  }
  if (present.has(journal.hostedFleetActive)) {
    capabilities.push(HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY);
  }
  if (present.has(journal.hostedReleaseActive)) {
    capabilities.push(hostedInferenceCapability(releaseSha));
  }
  if (present.has(journal.hostedDarkActive)) {
    capabilities.push(hostedInferenceDarkCapability(releaseSha));
  }
  return {
    releaseSha,
    generation,
    publicationLifecycleReady: present.has(journal.publicationReady),
    capabilities,
  };
}

async function captureAndDarkenManagedReleaseCapabilities(
  pool: Pool,
  releaseSha: string,
  publicationLifecycleReady: boolean,
): Promise<ManagedReleaseCapabilitySnapshot> {
  const names = managedReleaseCapabilityNames(releaseSha);
  const generation = randomUUID();
  const journal = managedReleasePreparationNames(releaseSha, generation);
  const client = await pool.connect();
  let releaseError: Error | undefined;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await lockPublicationLifecycleExclusive(client);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    // Adopt abandoned generations under the same locks and transaction that
    // immediately captures and darkens the replacement. Their desired state
    // is never committed as active while the fleet may still be mixed.
    await restoreAllManagedReleasePreparationsOnClient(client);
    const existing = await client.query<{ name: string }>(
      "SELECT name FROM deployment_capabilities WHERE name = ANY($1::text[]) ORDER BY name",
      [names],
    );
    const snapshot: ManagedReleaseCapabilitySnapshot = {
      releaseSha,
      generation,
      publicationLifecycleReady,
      capabilities: existing.rows.map((row) => row.name),
    };
    const journalNames = [
      journal.root,
      ...(publicationLifecycleReady ? [journal.publicationReady] : []),
      ...(snapshot.capabilities.includes(PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY)
        ? [journal.publicationActive]
        : []),
      ...(snapshot.capabilities.includes(HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY)
        ? [journal.hostedFleetActive]
        : []),
      ...(snapshot.capabilities.includes(hostedInferenceCapability(releaseSha))
        ? [journal.hostedReleaseActive]
        : []),
      ...(snapshot.capabilities.includes(hostedInferenceDarkCapability(releaseSha))
        ? [journal.hostedDarkActive]
        : []),
    ];
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       SELECT unnest($1::text[])
       ON CONFLICT (name) DO UPDATE SET activated_at = now()`,
      [journalNames],
    );
    if (publicationLifecycleReady) {
      await darkenPublicationLifecycle(client);
    }
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [hostedInferenceCapability(releaseSha)],
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY],
    );
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [hostedInferenceDarkCapability(releaseSha)],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return snapshot;
  } catch (error) {
    const primaryError = databaseClientError(
      error,
      "managed release capability capture failed",
    );
    if (!transactionOpen) {
      releaseError = primaryError;
      throw primaryError;
    }
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = databaseClientError(
        rollbackError,
        "managed release capability capture rollback failed",
      );
      throw new AggregateError(
        [primaryError, releaseError],
        "managed release capability capture and rollback failed",
      );
    }
    throw primaryError;
  } finally {
    client.release(releaseError);
  }
}

/** Darken one release and retain the exact capability state for compensation. */
export async function prepareManagedReleaseCapabilities(
  pool: Pool,
  releaseSha: string,
  publicationLifecycleReady: boolean,
): Promise<ManagedReleaseCapabilitySnapshot> {
  const normalizedRelease = normalizedReleaseSha(releaseSha);
  const snapshot = await captureAndDarkenManagedReleaseCapabilities(
    pool,
    normalizedRelease,
    publicationLifecycleReady,
  );
  try {
    if (publicationLifecycleReady) {
      await deactivatePublicationLifecycleRelease(pool);
    }
    return snapshot;
  } catch (error) {
    try {
      await restoreManagedReleaseCapabilities(pool, snapshot);
    } catch (restoreError) {
      throw new AggregateError(
        [
          databaseClientError(error, "managed release deactivation failed"),
          databaseClientError(
            restoreError,
            "managed release capability compensation failed",
          ),
        ],
        "managed release deactivation and capability compensation failed",
      );
    }
    throw error;
  }
}

/** Restore only the release capabilities changed during preparation. */
export async function restoreManagedReleaseCapabilities(
  pool: Pool,
  snapshot: ManagedReleaseCapabilitySnapshot,
): Promise<void> {
  await restoreManagedReleaseCapabilitiesInternal(pool, snapshot);
}

async function restoreManagedReleaseCapabilitiesInternal(
  pool: Pool,
  snapshot: ManagedReleaseCapabilitySnapshot,
): Promise<boolean> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await lockPublicationLifecycleExclusive(client);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const restored = await restoreManagedReleaseCapabilitiesOnClient(
      client,
      snapshot,
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return restored;
  } catch (error) {
    const primaryError = databaseClientError(
      error,
      "managed release capability compensation failed",
    );
    if (!transactionOpen) {
      releaseError = primaryError;
      throw primaryError;
    }
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = databaseClientError(
        rollbackError,
        "managed release capability compensation rollback failed",
      );
      throw new AggregateError(
        [primaryError, releaseError],
        "managed release capability compensation and rollback failed",
      );
    }
    throw primaryError;
  } finally {
    client.release(releaseError);
  }
}

async function restoreManagedReleaseCapabilitiesOnClient(
  client: PoolClient,
  snapshot: ManagedReleaseCapabilitySnapshot,
): Promise<boolean> {
  const names = managedReleaseCapabilityNames(snapshot.releaseSha);
  const journal = managedReleasePreparationNames(
    snapshot.releaseSha,
    snapshot.generation,
  );
  const journalNames = Object.values(journal);
  const durable = await client.query<{ name: string }>(
    "SELECT name FROM deployment_capabilities WHERE name = ANY($1::text[])",
    [journalNames],
  );
  const effectiveSnapshot = managedReleasePreparationSnapshot(
    snapshot.releaseSha,
    snapshot.generation,
    durable.rows.map((row) => row.name),
  );
  if (!effectiveSnapshot) return false;
  const expected = new Set(names);
  if (
    effectiveSnapshot.capabilities.some((name) => !expected.has(name)) ||
    new Set(effectiveSnapshot.capabilities).size !==
      effectiveSnapshot.capabilities.length
  ) {
    throw new Error("managed release capability snapshot is invalid");
  }
  const publicationWasActive = effectiveSnapshot.capabilities.includes(
    PUBLICATION_LIFECYCLE_FLEET_ACTIVE_CAPABILITY,
  );
  await client.query(
    "DELETE FROM deployment_capabilities WHERE name = ANY($1::text[])",
    [names],
  );
  if (effectiveSnapshot.capabilities.length > 0) {
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       SELECT unnest($1::text[])`,
      [effectiveSnapshot.capabilities],
    );
  }
  if (effectiveSnapshot.publicationLifecycleReady && publicationWasActive) {
    await client.query(
      `UPDATE jobs
          SET run_after = now(), payload = payload - $1
        WHERE kind = 'gate-state-sync'
          AND status = 'queued'
          AND payload ? $1`,
      [PUBLICATION_LIFECYCLE_DARK_PAYLOAD_KEY],
    );
  }
  if (
    effectiveSnapshot.capabilities.includes(
      HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY,
    )
  ) {
    await client.query(
      `UPDATE jobs
          SET run_after = now(), payload = payload - 'releaseDarkSha'
        WHERE kind IN ('review', $1)
          AND status = 'queued'
          AND run_after = 'infinity'::timestamptz
          AND payload ? 'releaseDarkSha'`,
      [HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND],
    );
  }
  await client.query(
    "DELETE FROM deployment_capabilities WHERE name = ANY($1::text[])",
    [journalNames],
  );
  return true;
}

async function restoreAllManagedReleasePreparationsOnClient(
  client: PoolClient,
): Promise<number> {
  const roots = await client.query<{ name: string }>(
    `SELECT name
       FROM deployment_capabilities
      WHERE name LIKE $1
        AND name LIKE '%:root'
      ORDER BY activated_at DESC, name DESC`,
    [`${MANAGED_RELEASE_PREPARATION_PREFIX}%`],
  );
  let restored = 0;
  for (const row of roots.rows) {
    const match = row.name.match(
      /^managed-release-preparation:([0-9a-f]{7,40}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):root$/,
    );
    if (!match) continue;
    const candidate: ManagedReleaseCapabilitySnapshot = {
      releaseSha: match[1]!,
      generation: match[2]!,
      publicationLifecycleReady: false,
      capabilities: [],
    };
    if (await restoreManagedReleaseCapabilitiesOnClient(client, candidate)) {
      restored += 1;
    }
  }
  return restored;
}

export async function restoreManagedReleasePreparation(
  pool: Pool,
  releaseSha: string,
  generation: string,
): Promise<boolean> {
  const normalizedRelease = normalizedReleaseSha(releaseSha);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation)) {
    throw new Error("managed release preparation generation is invalid");
  }
  const journal = managedReleasePreparationNames(
    normalizedRelease,
    generation,
  );
  const durable = await pool.query<{ name: string }>(
    "SELECT name FROM deployment_capabilities WHERE name = ANY($1::text[])",
    [Object.values(journal)],
  );
  const snapshot = managedReleasePreparationSnapshot(
    normalizedRelease,
    generation,
    durable.rows.map((row) => row.name),
  );
  if (!snapshot) return false;
  return restoreManagedReleaseCapabilitiesInternal(pool, snapshot);
}

/** Unwind every pending preparation from newest to oldest. */
export async function restoreAllManagedReleasePreparations(
  pool: Pool,
): Promise<number> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await lockPublicationLifecycleExclusive(client);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const restored = await restoreAllManagedReleasePreparationsOnClient(client);
    await client.query("COMMIT");
    transactionOpen = false;
    return restored;
  } catch (error) {
    const primaryError = databaseClientError(
      error,
      "managed release preparation recovery failed",
    );
    if (!transactionOpen) {
      releaseError = primaryError;
      throw primaryError;
    }
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = databaseClientError(
        rollbackError,
        "managed release preparation recovery rollback failed",
      );
      throw new AggregateError(
        [primaryError, releaseError],
        "managed release preparation recovery and rollback failed",
      );
    }
    throw primaryError;
  } finally {
    client.release(releaseError);
  }
}

/** Atomically park a claimed hosted review until a verified managed release activates. */
export async function deferHostedReviewForRelease(
  pool: Pool,
  job: { id: number; lockedBy: string },
  releaseSha: string,
): Promise<"deferred" | "released"> {
  return deferHostedJobForRelease(pool, job, releaseSha, "review");
}

/** Atomically park provider-key work until a verified managed release activates. */
export async function deferHostedProviderKeyLifecycleForRelease(
  pool: Pool,
  job: { id: number; lockedBy: string },
  releaseSha: string,
): Promise<"deferred" | "released"> {
  return deferHostedJobForRelease(
    pool,
    job,
    releaseSha,
    HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
  );
}

async function deferHostedJobForRelease(
  pool: Pool,
  job: { id: number; lockedBy: string },
  releaseSha: string,
  kind: "review" | typeof HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
): Promise<"deferred" | "released"> {
  const normalized = normalizedReleaseSha(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const active = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS active`,
      [HOSTED_INFERENCE_FLEET_ACTIVE_CAPABILITY],
    );
    const activated = active.rows[0]?.active === true;
    const updated = await client.query(
      `UPDATE jobs
          SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
              run_after = CASE
                WHEN $3::boolean THEN now()
                ELSE 'infinity'::timestamptz
              END,
              locked_at = NULL, locked_by = NULL, last_error = NULL,
              payload = CASE
                WHEN $3::boolean THEN payload - 'releaseDarkSha'
                ELSE payload || jsonb_build_object('releaseDarkSha', $4::text)
              END
        WHERE id = $1 AND kind = $5
          AND status = 'running' AND locked_by = $2`,
      [job.id, job.lockedBy, activated, normalized, kind],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new Error("hosted review release deferral lost its queue claim");
    }
    await client.query("COMMIT");
    return activated ? "released" : "deferred";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function enqueueHostedProviderKeyLifecycleBackfill(
  client: Pick<PoolClient, "query">,
  releaseSha: string,
): Promise<void> {
  const payload = (orgId: string): HostedProviderKeyLifecycleJobPayload => ({
    orgId: Number(orgId),
    releaseSha: normalizedReleaseSha(releaseSha),
  });
  const candidates = await client.query<{ org_id: string }>(
    `SELECT DISTINCT candidate.org_id::text
       FROM (
         SELECT entitlement.org_id
           FROM organization_entitlements entitlement
          WHERE entitlement.subscription_mode = 'hosted'
            AND entitlement.status <> 'suspended'
            AND entitlement.period_starts_at <= clock_timestamp()
            AND entitlement.period_ends_at > clock_timestamp()
            AND entitlement.included_usage_micros
                + COALESCE(entitlement.overage_hard_cap_micros, 0) > 0
            AND entitlement.included_usage_micros
                + COALESCE(entitlement.overage_hard_cap_micros, 0) <= $1::bigint
            AND (
              entitlement.status = 'active'
              OR (
                entitlement.status = 'trialing'
                AND entitlement.trial_ends_at > clock_timestamp()
              )
              OR (
                entitlement.status = 'past_due'
                AND entitlement.past_due_grace_ends_at > clock_timestamp()
              )
              OR (
                entitlement.promotional_eligible
                AND (
                  entitlement.promotional_ends_at IS NULL
                  OR entitlement.promotional_ends_at > clock_timestamp()
                )
              )
            )
         UNION
         SELECT lifecycle.org_id
           FROM hosted_provider_keys lifecycle
          WHERE lifecycle.state NOT IN ('revoked', 'cancelled')
       ) candidate
      ORDER BY candidate.org_id::text`,
    [OPENROUTER_EXACT_LIMIT_MAX_MICROS.toString()],
  );
  for (const candidate of candidates.rows) {
    const jobPayload = payload(candidate.org_id);
    await client.query(
      `WITH active AS MATERIALIZED (
         SELECT id, status
           FROM jobs
          WHERE kind = $1
            AND status IN ('queued', 'running')
            AND payload->>'orgId' = $2
          ORDER BY id
          FOR UPDATE
       ), refreshed AS (
         UPDATE jobs job
            SET payload = $3::jsonb,
                run_after = CASE
                  WHEN job.status = 'queued' THEN now()
                  ELSE job.run_after
                END,
                last_error = NULL
          WHERE job.id IN (SELECT id FROM active)
        RETURNING job.id
       )
       INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT $1, $3::jsonb, 'queued', now(), 25
        WHERE NOT EXISTS (SELECT 1 FROM active)`,
      [
        HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
        candidate.org_id,
        JSON.stringify(jobPayload),
      ],
    );
  }
}

/** Activate private-review author enforcement after every managed process runs compatible code. */
export async function activatePrivateReviewAuthorIdentity(
  pool: Pool,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PRIVATE_REVIEW_AUTHOR_LOCK],
    );
    const anonymousActive = await client.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM reviews
         JOIN repositories ON repositories.id = reviews.repository_id
         WHERE repositories.private = true
           AND reviews.status IN ('queued', 'running')
           AND (
             reviews.author_github_id IS NULL
             OR reviews.author_github_id <= 0
             OR reviews.author_github_id > 9007199254740991
             OR reviews.author_login IS NULL
             OR length(btrim(reviews.author_login)) = 0
             OR length(reviews.author_login) > 100
           )
       ) AS blocked`,
    );
    if (anonymousActive.rows[0]?.blocked) {
      throw new Error(
        "private review author enforcement has anonymous active reviews",
      );
    }
    const activated = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [PRIVATE_REVIEW_AUTHOR_CAPABILITY],
    );
    await client.query("COMMIT");
    return (activated.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Activate new job consumers after the deploy has replaced every old
 * process. The migration's insert trigger takes the same transaction lock, so
 * no staged job can commit at infinity between this release UPDATE and
 * capability activation.
 */
export async function activateReleaseJobs(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [ADVISORY_LOCK_NAME],
    );
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [RELEASE_V1_JOBS_CAPABILITY],
    );
    const released = await client.query(
      `UPDATE jobs
       SET run_after = now()
       WHERE kind = ANY($1::text[])
         AND status = 'queued'
         AND run_after = 'infinity'::timestamptz`,
      [RELEASE_V1_JOB_KINDS],
    );
    await client.query("COMMIT");
    return released.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
