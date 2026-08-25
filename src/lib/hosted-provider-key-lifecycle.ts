import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  exactOpenRouterLimitMicros,
  OPENROUTER_EXACT_LIMIT_MAX_MICROS,
  type ExactOpenRouterLimitMicros,
  type OpenRouterManagedKey,
  type OpenRouterManagementAdapter,
} from "@/lib/openrouter-management-adapter";

export type HostedProviderKeyLifecycleResult =
  | {
      readonly status: "created";
      readonly intentId: string;
      readonly providerKeyHash: string;
      readonly periodStartsAt: Date;
      readonly periodEndsAt: Date;
      readonly limitMicros: bigint;
    }
  | {
      readonly status: "active";
      readonly intentId: string;
      readonly providerKeyHash: string;
      readonly periodStartsAt: Date;
      readonly periodEndsAt: Date;
      readonly limitMicros: bigint;
    }
  | {
      readonly status: "inactive";
      readonly reason: InactiveEntitlementReason;
      readonly revocationsCompleted: number;
    }
  | {
      readonly status: "busy";
      readonly operation: "create" | "revoke";
    }
  | {
      readonly status: "rejected";
      readonly operation: "create" | "revoke";
      readonly intentId: string;
      readonly httpStatus?: number;
    }
  | {
      readonly status: "revocation-pending";
      readonly intentId: string;
      readonly providerKeyHash: string;
    }
  | {
      readonly status: "revoked";
      readonly intentId: string;
      readonly providerKeyHash: string;
      readonly observed: "disabled" | "absent";
    }
  | {
      readonly status: "orphaned";
      readonly intentId: string;
      readonly reason:
        | "attempted-without-provider-match"
        | "intent-changed"
        | "name-not-unique"
        | "name-present"
        | "provider-outcome-ambiguous";
      readonly matches: readonly OpenRouterManagedKey[];
    }
  | {
      readonly status: "ownership-conflict";
      readonly intentId: string;
      readonly providerKeyHash: string;
    }
  | {
      readonly status: "blocked";
      readonly intentId: string;
      readonly state: string;
    }
  | {
      readonly status: "reconciliation-bound";
    };

type InactiveEntitlementReason =
  | "no-entitlement"
  | "not-hosted"
  | "suspended"
  | "inactive"
  | "period-missing"
  | "period-not-current"
  | "zero-limit"
  | "limit-not-exactly-representable";

interface LifecycleInput {
  readonly orgId: number;
  readonly sealRuntimeKey: (runtimeKey: string) => Buffer | Promise<Buffer>;
}

interface EntitlementRow {
  readonly organization_exists: boolean;
  readonly subscription_mode: string | null;
  readonly status: string | null;
  readonly trial_ends_at: Date | null;
  readonly past_due_grace_ends_at: Date | null;
  readonly period_starts_at: Date | null;
  readonly period_ends_at: Date | null;
  readonly included_usage_micros: string | null;
  readonly overage_hard_cap_micros: string | null;
  readonly promotional_eligible: boolean | null;
  readonly promotional_ends_at: Date | null;
  readonly entitlement_updated_at: Date | null;
  readonly database_now: Date;
}

interface DesiredBinding {
  readonly orgId: number;
  readonly limitMicros: ExactOpenRouterLimitMicros;
}

interface EntitlementDecision {
  readonly desired: DesiredBinding | null;
  readonly reason: InactiveEntitlementReason | null;
}

interface HostedProviderKeyRow {
  readonly create_intent_id: string;
  readonly org_id: string;
  readonly state: string;
  readonly provider_key_name: string;
  readonly provider_key_hash: string | null;
  readonly conflicting_provider_key_hash: string | null;
  readonly sealed_runtime_key: Buffer | null;
  readonly entitlement_period_starts_at: Date;
  readonly entitlement_period_ends_at: Date;
  readonly entitlement_updated_at: Date;
  readonly limit_micros: string;
  readonly create_attempted_at: Date | null;
  readonly create_outcome: string | null;
  readonly lease_id: string | null;
  readonly lease_kind: string | null;
  readonly lease_expires_at: Date | null;
}

export interface HostedProviderRuntimeCredential {
  readonly intentId: string;
  readonly providerKeyHash: string;
  readonly sealedRuntimeKey: Buffer;
  readonly periodStartsAt: Date;
  readonly periodEndsAt: Date;
  readonly limitMicros: bigint;
}

const LEASE_DURATION_SQL = "5 minutes";
const MAX_RECONCILIATIONS_PER_CALL = 16;
const PROVIDER_KEY_NAME_PREFIX = "postil-hosted-";

/**
 * Reconcile one organization's dark provider key against its durable hosted
 * entitlement. Database time controls entitlement validity, leases, and every
 * lifecycle timestamp.
 */
export async function reconcileHostedProviderKeyLifecycle(
  pool: Pick<Pool, "connect">,
  adapter: OpenRouterManagementAdapter,
  input: LifecycleInput,
): Promise<HostedProviderKeyLifecycleResult> {
  validateLifecycleInput(input);
  const client = await pool.connect();
  try {
    const entitlement = await readEntitlementDecision(client, input.orgId);
    await normalizeLifecycleRows(client, input.orgId);

    let revocationsCompleted = 0;
    for (let index = 0; index < MAX_RECONCILIATIONS_PER_CALL; index += 1) {
      const pending = await readNextRevocation(client, input.orgId);
      if (pending) {
        const result = await revokeProviderKey(client, adapter, pending);
        if (result.status === "revoked") {
          revocationsCompleted += 1;
          continue;
        }
        return result;
      }

      const ambiguous = await readNextAmbiguousCreate(client, input.orgId);
      if (ambiguous) {
        const result = await reconcileAmbiguousCreate(client, adapter, ambiguous);
        if (result.status === "revoked") {
          revocationsCompleted += 1;
          continue;
        }
        return result;
      }

      if (!entitlement.desired) {
        return {
          status: "inactive",
          reason: entitlement.reason ?? "inactive",
          revocationsCompleted,
        };
      }

      const intent = await persistOrReadIntent(client, entitlement.desired);
      const terminal = terminalIntentResult(intent);
      if (terminal) return terminal;

      const leaseId = randomUUID();
      const leased = await claimCreateLease(client, intent, leaseId);
      if (!leased) return { status: "busy", operation: "create" };
      try {
        return await createWhileLeased(
          client,
          adapter,
          input.sealRuntimeKey,
          leased,
          leaseId,
        );
      } finally {
        await releaseLease(client, leased.create_intent_id, leaseId);
      }
    }
    return { status: "reconciliation-bound" };
  } finally {
    client.release();
  }
}

/**
 * Return a sealed credential only while its exact entitlement period and cap
 * remain active according to PostgreSQL time. No production caller uses this
 * dark resolver.
 */
export async function resolveHostedProviderRuntimeCredential(
  pool: Pick<Pool, "connect">,
  orgId: number,
): Promise<HostedProviderRuntimeCredential | null> {
  if (!Number.isSafeInteger(orgId) || orgId <= 0) {
    throw new Error("hosted provider lifecycle organization id is invalid");
  }
  const client = await pool.connect();
  try {
    const result = await client.query<{
      create_intent_id: string;
      provider_key_hash: string;
      sealed_runtime_key: Buffer;
      entitlement_period_starts_at: Date;
      entitlement_period_ends_at: Date;
      limit_micros: string;
    }>(
      `SELECT h.create_intent_id, h.provider_key_hash, h.sealed_runtime_key,
              h.entitlement_period_starts_at, h.entitlement_period_ends_at,
              h.limit_micros
       FROM hosted_provider_keys h
       JOIN organization_entitlements e ON e.org_id = h.org_id
       WHERE h.org_id = $1
         AND h.state = 'active'
         AND h.sealed_runtime_key IS NOT NULL
         AND h.provider_key_hash IS NOT NULL
         AND e.subscription_mode = 'hosted'
         AND e.status <> 'suspended'
         AND e.period_starts_at = h.entitlement_period_starts_at
         AND e.period_ends_at = h.entitlement_period_ends_at
         AND e.included_usage_micros + COALESCE(e.overage_hard_cap_micros, 0) = h.limit_micros
         AND e.period_starts_at <= clock_timestamp()
         AND e.period_ends_at > clock_timestamp()
         AND (
           e.status = 'active'
           OR (e.status = 'trialing' AND e.trial_ends_at > clock_timestamp())
           OR (e.status = 'past_due' AND e.past_due_grace_ends_at > clock_timestamp())
           OR (
             e.promotional_eligible
             AND (e.promotional_ends_at IS NULL OR e.promotional_ends_at > clock_timestamp())
           )
         )
       LIMIT 1`,
      [orgId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      intentId: row.create_intent_id,
      providerKeyHash: row.provider_key_hash,
      sealedRuntimeKey: Buffer.from(row.sealed_runtime_key),
      periodStartsAt: row.entitlement_period_starts_at,
      periodEndsAt: row.entitlement_period_ends_at,
      limitMicros: BigInt(row.limit_micros),
    };
  } finally {
    client.release();
  }
}

async function readEntitlementDecision(
  client: PoolClient,
  orgId: number,
): Promise<EntitlementDecision> {
  const result = await client.query<EntitlementRow>(
    `SELECT EXISTS(SELECT 1 FROM organizations WHERE id = $1) AS organization_exists,
            e.subscription_mode, e.status, e.trial_ends_at,
            e.past_due_grace_ends_at, e.period_starts_at, e.period_ends_at,
            e.included_usage_micros::text, e.overage_hard_cap_micros::text,
            e.promotional_eligible, e.promotional_ends_at,
            e.updated_at AS entitlement_updated_at,
            clock_timestamp() AS database_now
     FROM (SELECT 1) anchor
     LEFT JOIN organization_entitlements e ON e.org_id = $1`,
    [orgId],
  );
  const row = result.rows[0];
  if (!row?.organization_exists) {
    throw new Error("hosted provider lifecycle organization does not exist");
  }
  if (!row.subscription_mode || !row.status) {
    return { desired: null, reason: "no-entitlement" };
  }
  if (row.subscription_mode !== "hosted") {
    return { desired: null, reason: "not-hosted" };
  }
  if (row.status === "suspended") {
    return { desired: null, reason: "suspended" };
  }
  if (
    !row.period_starts_at ||
    !row.period_ends_at ||
    !row.entitlement_updated_at ||
    row.period_ends_at <= row.period_starts_at
  ) {
    return { desired: null, reason: "period-missing" };
  }
  if (
    row.database_now < row.period_starts_at ||
    row.database_now >= row.period_ends_at
  ) {
    return { desired: null, reason: "period-not-current" };
  }

  const promotionActive = Boolean(
    row.promotional_eligible &&
      (!row.promotional_ends_at || row.promotional_ends_at > row.database_now),
  );
  const statusActive =
    row.status === "active" ||
    (row.status === "trialing" &&
      row.trial_ends_at !== null &&
      row.trial_ends_at > row.database_now) ||
    (row.status === "past_due" &&
      row.past_due_grace_ends_at !== null &&
      row.past_due_grace_ends_at > row.database_now) ||
    promotionActive;
  if (!statusActive) return { desired: null, reason: "inactive" };

  const included = BigInt(row.included_usage_micros ?? "0");
  const overage = BigInt(row.overage_hard_cap_micros ?? "0");
  const limitMicros = included + overage;
  if (limitMicros <= 0n) return { desired: null, reason: "zero-limit" };
  if (limitMicros > OPENROUTER_EXACT_LIMIT_MAX_MICROS) {
    return { desired: null, reason: "limit-not-exactly-representable" };
  }
  return {
    desired: {
      orgId,
      limitMicros: exactOpenRouterLimitMicros(limitMicros),
    },
    reason: null,
  };
}

async function normalizeLifecycleRows(
  client: PoolClient,
  orgId: number,
): Promise<void> {
  await client.query(
    `UPDATE hosted_provider_keys
     SET state = 'revocation_pending',
         sealed_runtime_key = NULL,
         revocation_requested_at = COALESCE(revocation_requested_at, clock_timestamp()),
         reconciliation_required_at = COALESCE(reconciliation_required_at, clock_timestamp()),
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE org_id = $1
       AND state IN ('activating', 'active')
       AND NOT EXISTS (
         SELECT 1
         FROM organization_entitlements e
         WHERE e.org_id = hosted_provider_keys.org_id
           AND e.subscription_mode = 'hosted'
           AND e.status <> 'suspended'
           AND e.period_starts_at = hosted_provider_keys.entitlement_period_starts_at
           AND e.period_ends_at = hosted_provider_keys.entitlement_period_ends_at
           AND e.included_usage_micros + COALESCE(e.overage_hard_cap_micros, 0) = hosted_provider_keys.limit_micros
           AND e.period_starts_at <= clock_timestamp()
           AND e.period_ends_at > clock_timestamp()
           AND (
             e.status = 'active'
             OR (e.status = 'trialing' AND e.trial_ends_at > clock_timestamp())
             OR (e.status = 'past_due' AND e.past_due_grace_ends_at > clock_timestamp())
             OR (
               e.promotional_eligible
               AND (e.promotional_ends_at IS NULL OR e.promotional_ends_at > clock_timestamp())
             )
           )
       )`,
    [orgId],
  );
  await client.query(
    `UPDATE hosted_provider_keys
     SET state = 'revocation_pending',
         sealed_runtime_key = NULL,
         revocation_requested_at = COALESCE(revocation_requested_at, clock_timestamp()),
         reconciliation_required_at = COALESCE(reconciliation_required_at, clock_timestamp()),
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE org_id = $1
       AND state = 'activating'
       AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp())`,
    [orgId],
  );
  await client.query(
    `UPDATE hosted_provider_keys
     SET state = 'orphaned',
         create_outcome = 'ambiguous',
         reconciliation_required_at = COALESCE(reconciliation_required_at, clock_timestamp()),
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE org_id = $1
       AND state = 'provisioning'
       AND create_attempted_at IS NOT NULL
       AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp())`,
    [orgId],
  );
}

async function persistOrReadIntent(
  client: PoolClient,
  desired: DesiredBinding,
): Promise<HostedProviderKeyRow> {
  const intentId = randomUUID();
  const providerKeyName = `${PROVIDER_KEY_NAME_PREFIX}${intentId}`;
  const inserted = await client.query<HostedProviderKeyRow>(
    `INSERT INTO hosted_provider_keys
       (create_intent_id, org_id, state, provider_key_name,
        entitlement_period_starts_at, entitlement_period_ends_at,
        entitlement_updated_at, limit_micros, created_at, updated_at)
     SELECT $1, e.org_id, 'provisioning', $2, e.period_starts_at,
            e.period_ends_at, e.updated_at, $4, clock_timestamp(), clock_timestamp()
     FROM organization_entitlements e
     WHERE e.org_id = $3
       AND e.subscription_mode = 'hosted'
       AND e.status <> 'suspended'
       AND e.included_usage_micros + COALESCE(e.overage_hard_cap_micros, 0) = $4::bigint
       AND e.period_starts_at <= clock_timestamp()
       AND e.period_ends_at > clock_timestamp()
       AND (
         e.status = 'active'
         OR (e.status = 'trialing' AND e.trial_ends_at > clock_timestamp())
         OR (e.status = 'past_due' AND e.past_due_grace_ends_at > clock_timestamp())
         OR (
           e.promotional_eligible
           AND (e.promotional_ends_at IS NULL OR e.promotional_ends_at > clock_timestamp())
         )
       )
     ON CONFLICT DO NOTHING
     RETURNING ${RETURNING_COLUMNS}`,
    [
      intentId,
      providerKeyName,
      desired.orgId,
      desired.limitMicros.toString(),
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await client.query<HostedProviderKeyRow>(
    `SELECT ${QUALIFIED_SELECT_COLUMNS}
     FROM hosted_provider_keys h
     JOIN organization_entitlements e ON e.org_id = h.org_id
     WHERE h.org_id = $1
       AND h.entitlement_period_starts_at = e.period_starts_at
       AND h.entitlement_period_ends_at = e.period_ends_at
       AND h.limit_micros = e.included_usage_micros + COALESCE(e.overage_hard_cap_micros, 0)
       AND h.limit_micros = $2::bigint
       AND e.subscription_mode = 'hosted'
       AND e.status <> 'suspended'
       AND e.period_starts_at <= clock_timestamp()
       AND e.period_ends_at > clock_timestamp()
       AND (
         e.status = 'active'
         OR (e.status = 'trialing' AND e.trial_ends_at > clock_timestamp())
         OR (e.status = 'past_due' AND e.past_due_grace_ends_at > clock_timestamp())
         OR (
           e.promotional_eligible
           AND (e.promotional_ends_at IS NULL OR e.promotional_ends_at > clock_timestamp())
         )
       )
     LIMIT 1`,
    [desired.orgId, desired.limitMicros.toString()],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error("hosted provider intent could not bind the current entitlement");
  }
  return row;
}

function terminalIntentResult(
  row: HostedProviderKeyRow,
): HostedProviderKeyLifecycleResult | null {
  if (row.state === "active" && row.provider_key_hash) {
    return {
      status: "active",
      intentId: row.create_intent_id,
      providerKeyHash: row.provider_key_hash,
      periodStartsAt: row.entitlement_period_starts_at,
      periodEndsAt: row.entitlement_period_ends_at,
      limitMicros: BigInt(row.limit_micros),
    };
  }
  if (row.state === "rejected") {
    return {
      status: "rejected",
      operation: "create",
      intentId: row.create_intent_id,
    };
  }
  if (row.state !== "provisioning") {
    return {
      status: "blocked",
      intentId: row.create_intent_id,
      state: row.state,
    };
  }
  return null;
}

async function claimCreateLease(
  client: PoolClient,
  row: HostedProviderKeyRow,
  leaseId: string,
): Promise<HostedProviderKeyRow | null> {
  const result = await client.query<HostedProviderKeyRow>(
    `UPDATE hosted_provider_keys
     SET lease_id = $2,
         lease_kind = 'create',
         lease_expires_at = clock_timestamp() + $3::interval,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND state = 'provisioning'
       AND create_attempted_at IS NULL
       AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp())
     RETURNING ${RETURNING_COLUMNS}`,
    [row.create_intent_id, leaseId, LEASE_DURATION_SQL],
  );
  return result.rows[0] ?? null;
}

async function createWhileLeased(
  client: PoolClient,
  adapter: OpenRouterManagementAdapter,
  sealRuntimeKey: LifecycleInput["sealRuntimeKey"],
  row: HostedProviderKeyRow,
  leaseId: string,
): Promise<HostedProviderKeyLifecycleResult> {
  const lookup = await adapter.findKeysByExactName(row.provider_key_name);
  if (lookup.status === "one") {
    await markOrphaned(client, row, leaseId, "name_present", null);
    return {
      status: "orphaned",
      intentId: row.create_intent_id,
      reason: "name-present",
      matches: lookup.matches,
    };
  }
  if (lookup.status === "multiple") {
    await markOrphaned(client, row, leaseId, "name_not_unique", null);
    return {
      status: "orphaned",
      intentId: row.create_intent_id,
      reason: "name-not-unique",
      matches: lookup.matches,
    };
  }

  const attempted = await client.query(
    `UPDATE hosted_provider_keys h
     SET create_attempted_at = clock_timestamp(),
         reconciliation_required_at = clock_timestamp(),
         entitlement_updated_at = e.updated_at,
         updated_at = clock_timestamp()
     FROM organization_entitlements e
     WHERE h.create_intent_id = $1
       AND h.state = 'provisioning'
       AND h.create_attempted_at IS NULL
       AND h.lease_id = $2
       AND h.lease_kind = 'create'
       AND h.lease_expires_at > clock_timestamp()
       AND e.org_id = h.org_id
       AND e.subscription_mode = 'hosted'
       AND e.status <> 'suspended'
       AND e.period_starts_at = h.entitlement_period_starts_at
       AND e.period_ends_at = h.entitlement_period_ends_at
       AND e.included_usage_micros + COALESCE(e.overage_hard_cap_micros, 0) = h.limit_micros
       AND e.period_starts_at <= clock_timestamp()
       AND e.period_ends_at > clock_timestamp()
       AND (
         e.status = 'active'
         OR (e.status = 'trialing' AND e.trial_ends_at > clock_timestamp())
         OR (e.status = 'past_due' AND e.past_due_grace_ends_at > clock_timestamp())
         OR (
           e.promotional_eligible
           AND (e.promotional_ends_at IS NULL OR e.promotional_ends_at > clock_timestamp())
         )
       )
     RETURNING h.create_intent_id`,
    [row.create_intent_id, leaseId],
  );
  if (attempted.rowCount !== 1) {
    await markOrphaned(client, row, leaseId, "intent_changed", null);
    return {
      status: "orphaned",
      intentId: row.create_intent_id,
      reason: "intent-changed",
      matches: [],
    };
  }

  const created = await adapter.createKeyAfterPersistedIntent({
    intentId: row.create_intent_id,
    name: row.provider_key_name,
    limitMicros: exactOpenRouterLimitMicros(BigInt(row.limit_micros)),
    expiresAt: row.entitlement_period_ends_at,
  });
  if (created.status === "rejected") {
    await transitionCreateRejected(client, row, leaseId);
    return {
      status: "rejected",
      operation: "create",
      intentId: row.create_intent_id,
      httpStatus: created.httpStatus,
    };
  }
  if (created.status === "ambiguous") {
    await markOrphaned(client, row, leaseId, "ambiguous", null);
    return {
      status: "orphaned",
      intentId: row.create_intent_id,
      reason: "provider-outcome-ambiguous",
      matches: [],
    };
  }

  const hashClaim = await claimCreatedProviderHash(
    client,
    row,
    leaseId,
    created.key.hash,
  );
  if (hashClaim === "ownership-conflict") {
    await markOwnershipConflict(client, row, leaseId, created.key.hash);
    return {
      status: "ownership-conflict",
      intentId: row.create_intent_id,
      providerKeyHash: created.key.hash,
    };
  }
  if (hashClaim === "intent-changed") {
    const recovered = await transitionKnownCreatedKeyToRevocation(
      client,
      row.create_intent_id,
      created.key.hash,
    );
    if (recovered === "ownership-conflict") {
      await markOwnershipConflict(client, row, leaseId, created.key.hash);
      return {
        status: "ownership-conflict",
        intentId: row.create_intent_id,
        providerKeyHash: created.key.hash,
      };
    }
    if (recovered === "revocation-pending") {
      const pending = await readIntent(client, row.create_intent_id);
      if (!pending) {
        throw new Error("hosted provider recovered revocation intent disappeared");
      }
      return revokeProviderKey(client, adapter, pending);
    }
    throw new Error(
      "hosted provider create result could not persist its immutable hash",
    );
  }

  let sealedRuntimeKey: Buffer;
  try {
    sealedRuntimeKey = Buffer.from(await sealRuntimeKey(created.runtimeKey));
    if (sealedRuntimeKey.byteLength === 0) {
      throw new Error("sealed provider runtime key is empty");
    }
  } catch {
    await transitionToRevocationPending(
      client,
      row.create_intent_id,
      leaseId,
      "credential_persistence_failed",
    );
    const pending = await readIntent(client, row.create_intent_id);
    if (!pending) throw new Error("hosted provider revocation intent disappeared");
    return revokeProviderKey(client, adapter, pending);
  }

  const activated = await activateIfEntitlementStillMatches(
    client,
    row.create_intent_id,
    leaseId,
    sealedRuntimeKey,
  );
  if (!activated) {
    await transitionToRevocationPending(
      client,
      row.create_intent_id,
      leaseId,
      "created",
    );
    const pending = await readIntent(client, row.create_intent_id);
    if (pending?.state === "revocation_pending") {
      return revokeProviderKey(client, adapter, pending);
    }
    return {
      status: "orphaned",
      intentId: row.create_intent_id,
      reason: "intent-changed",
      matches: [created.key],
    };
  }
  return {
    status: "created",
    intentId: row.create_intent_id,
    providerKeyHash: created.key.hash,
    periodStartsAt: row.entitlement_period_starts_at,
    periodEndsAt: row.entitlement_period_ends_at,
    limitMicros: BigInt(row.limit_micros),
  };
}

async function claimCreatedProviderHash(
  client: PoolClient,
  row: HostedProviderKeyRow,
  leaseId: string,
  providerKeyHash: string,
): Promise<"claimed" | "intent-changed" | "ownership-conflict"> {
  try {
    const result = await client.query(
      `UPDATE hosted_provider_keys target
       SET state = 'activating',
           provider_key_hash = $3,
           create_outcome = 'created',
           reconciliation_required_at = COALESCE(reconciliation_required_at, clock_timestamp()),
           updated_at = clock_timestamp()
       WHERE target.create_intent_id = $1
         AND target.state = 'provisioning'
         AND target.lease_id = $2
         AND target.lease_kind = 'create'
         AND target.lease_expires_at > clock_timestamp()
         AND NOT EXISTS (
           SELECT 1
           FROM hosted_provider_keys owner
           WHERE owner.provider_key_hash = $3
             AND owner.create_intent_id <> target.create_intent_id
         )
       RETURNING target.create_intent_id`,
      [row.create_intent_id, leaseId, providerKeyHash],
    );
    if (result.rowCount === 1) return "claimed";
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return "ownership-conflict";
    }
    throw error;
  }
  return (await providerHashHasOtherOwner(client, row.create_intent_id, providerKeyHash))
    ? "ownership-conflict"
    : "intent-changed";
}

async function transitionKnownCreatedKeyToRevocation(
  client: PoolClient,
  intentId: string,
  providerKeyHash: string,
): Promise<"revocation-pending" | "ownership-conflict" | "intent-changed"> {
  try {
    const result = await client.query(
      `UPDATE hosted_provider_keys target
       SET state = 'revocation_pending',
           provider_key_hash = $2,
           sealed_runtime_key = NULL,
           conflicting_provider_key_hash = NULL,
           create_outcome = 'created',
           revocation_requested_at = clock_timestamp(),
           reconciliation_required_at = clock_timestamp(),
           lease_id = NULL,
           lease_kind = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
       WHERE target.create_intent_id = $1
         AND target.state IN ('provisioning', 'orphaned')
         AND target.create_attempted_at IS NOT NULL
         AND target.provider_key_hash IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM hosted_provider_keys owner
           WHERE owner.provider_key_hash = $2
             AND owner.create_intent_id <> target.create_intent_id
         )
       RETURNING target.create_intent_id`,
      [intentId, providerKeyHash],
    );
    if (result.rowCount === 1) return "revocation-pending";
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return "ownership-conflict";
    }
    throw error;
  }
  return (await providerHashHasOtherOwner(client, intentId, providerKeyHash))
    ? "ownership-conflict"
    : "intent-changed";
}

async function activateIfEntitlementStillMatches(
  client: PoolClient,
  intentId: string,
  leaseId: string,
  sealedRuntimeKey: Buffer,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE hosted_provider_keys h
     SET state = 'active',
         sealed_runtime_key = $3,
         entitlement_updated_at = e.updated_at,
         reconciliation_required_at = NULL,
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     FROM organization_entitlements e
     WHERE h.create_intent_id = $1
       AND h.lease_id = $2
       AND h.lease_kind = 'create'
       AND h.lease_expires_at > clock_timestamp()
       AND h.state = 'activating'
       AND e.org_id = h.org_id
       AND e.subscription_mode = 'hosted'
       AND e.status <> 'suspended'
       AND e.period_starts_at = h.entitlement_period_starts_at
       AND e.period_ends_at = h.entitlement_period_ends_at
       AND e.included_usage_micros + COALESCE(e.overage_hard_cap_micros, 0) = h.limit_micros
       AND e.period_starts_at <= clock_timestamp()
       AND e.period_ends_at > clock_timestamp()
       AND (
         e.status = 'active'
         OR (e.status = 'trialing' AND e.trial_ends_at > clock_timestamp())
         OR (e.status = 'past_due' AND e.past_due_grace_ends_at > clock_timestamp())
         OR (
           e.promotional_eligible
           AND (e.promotional_ends_at IS NULL OR e.promotional_ends_at > clock_timestamp())
         )
       )
     RETURNING h.create_intent_id`,
    [intentId, leaseId, sealedRuntimeKey],
  );
  return result.rowCount === 1;
}

async function readNextAmbiguousCreate(
  client: PoolClient,
  orgId: number,
): Promise<HostedProviderKeyRow | null> {
  const result = await client.query<HostedProviderKeyRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM hosted_provider_keys
     WHERE org_id = $1
       AND state = 'orphaned'
       AND create_outcome = 'ambiguous'
       AND provider_key_hash IS NULL
     ORDER BY reconciliation_required_at, create_intent_id
     LIMIT 1`,
    [orgId],
  );
  return result.rows[0] ?? null;
}

async function reconcileAmbiguousCreate(
  client: PoolClient,
  adapter: OpenRouterManagementAdapter,
  row: HostedProviderKeyRow,
): Promise<HostedProviderKeyLifecycleResult> {
  const leaseId = randomUUID();
  const claimed = await client.query<HostedProviderKeyRow>(
    `UPDATE hosted_provider_keys
     SET lease_id = $2,
         lease_kind = 'create',
         lease_expires_at = clock_timestamp() + $3::interval,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND state = 'orphaned'
       AND create_outcome = 'ambiguous'
       AND provider_key_hash IS NULL
       AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp())
     RETURNING ${RETURNING_COLUMNS}`,
    [row.create_intent_id, leaseId, LEASE_DURATION_SQL],
  );
  const leased = claimed.rows[0];
  if (!leased) return { status: "busy", operation: "create" };
  try {
    const lookup = await adapter.findKeysByExactName(leased.provider_key_name);
    if (lookup.status === "none") {
      return {
        status: "orphaned",
        intentId: leased.create_intent_id,
        reason: "attempted-without-provider-match",
        matches: [],
      };
    }
    if (lookup.status === "multiple") {
      await markOrphaned(
        client,
        leased,
        leaseId,
        "name_not_unique",
        null,
      );
      return {
        status: "orphaned",
        intentId: leased.create_intent_id,
        reason: "name-not-unique",
        matches: lookup.matches,
      };
    }
    const providerKeyHash = lookup.matches[0].hash;
    const transitioned = await claimRecoveredProviderHash(
      client,
      leased,
      leaseId,
      providerKeyHash,
    );
    if (transitioned === "ownership-conflict") {
      await markOwnershipConflict(
        client,
        leased,
        leaseId,
        providerKeyHash,
      );
      return {
        status: "ownership-conflict",
        intentId: leased.create_intent_id,
        providerKeyHash,
      };
    }
    if (transitioned === "intent-changed") {
      return {
        status: "orphaned",
        intentId: leased.create_intent_id,
        reason: "intent-changed",
        matches: lookup.matches,
      };
    }
  } finally {
    await releaseLease(client, leased.create_intent_id, leaseId);
  }
  const pending = await readIntent(client, leased.create_intent_id);
  if (!pending) throw new Error("hosted provider recovered intent disappeared");
  return revokeProviderKey(client, adapter, pending);
}

async function claimRecoveredProviderHash(
  client: PoolClient,
  row: HostedProviderKeyRow,
  leaseId: string,
  providerKeyHash: string,
): Promise<"claimed" | "intent-changed" | "ownership-conflict"> {
  try {
    const result = await client.query(
      `UPDATE hosted_provider_keys target
       SET state = 'revocation_pending',
           provider_key_hash = $3,
           revocation_requested_at = clock_timestamp(),
           reconciliation_required_at = clock_timestamp(),
           lease_id = NULL,
           lease_kind = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
       WHERE target.create_intent_id = $1
         AND target.state = 'orphaned'
         AND target.create_outcome = 'ambiguous'
         AND target.lease_id = $2
         AND target.lease_kind = 'create'
         AND target.lease_expires_at > clock_timestamp()
         AND NOT EXISTS (
           SELECT 1
           FROM hosted_provider_keys owner
           WHERE owner.provider_key_hash = $3
             AND owner.create_intent_id <> target.create_intent_id
         )
       RETURNING target.create_intent_id`,
      [row.create_intent_id, leaseId, providerKeyHash],
    );
    if (result.rowCount === 1) return "claimed";
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return "ownership-conflict";
    }
    throw error;
  }
  return (await providerHashHasOtherOwner(client, row.create_intent_id, providerKeyHash))
    ? "ownership-conflict"
    : "intent-changed";
}

async function providerHashHasOtherOwner(
  client: PoolClient,
  intentId: string,
  providerKeyHash: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM hosted_provider_keys
     WHERE provider_key_hash = $1
       AND create_intent_id <> $2
     LIMIT 1`,
    [providerKeyHash, intentId],
  );
  return result.rowCount === 1;
}

async function readNextRevocation(
  client: PoolClient,
  orgId: number,
): Promise<HostedProviderKeyRow | null> {
  const result = await client.query<HostedProviderKeyRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM hosted_provider_keys
     WHERE org_id = $1
       AND state = 'revocation_pending'
     ORDER BY reconciliation_required_at, create_intent_id
     LIMIT 1`,
    [orgId],
  );
  return result.rows[0] ?? null;
}

async function revokeProviderKey(
  client: PoolClient,
  adapter: OpenRouterManagementAdapter,
  row: HostedProviderKeyRow,
): Promise<HostedProviderKeyLifecycleResult> {
  if (!row.provider_key_hash) {
    throw new Error("hosted provider revocation is missing its immutable hash");
  }
  const leaseId = randomUUID();
  const claimed = await client.query<HostedProviderKeyRow>(
    `UPDATE hosted_provider_keys
     SET lease_id = $2,
         lease_kind = 'revoke',
         lease_expires_at = clock_timestamp() + $3::interval,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND state = 'revocation_pending'
       AND provider_key_hash IS NOT NULL
       AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp())
     RETURNING ${RETURNING_COLUMNS}`,
    [row.create_intent_id, leaseId, LEASE_DURATION_SQL],
  );
  const leased = claimed.rows[0];
  if (!leased) return { status: "busy", operation: "revoke" };

  try {
    let before: "active" | "disabled" | "absent";
    try {
      before = await observeProviderKey(adapter, leased.provider_key_hash!);
    } catch {
      await recordPendingRevocation(client, leased, leaseId, "ambiguous");
      return pendingRevocationResult(leased);
    }
    if (before !== "active") {
      return markRevoked(client, leased, leaseId, before);
    }

    const authorized = await client.query(
      `UPDATE hosted_provider_keys
       SET revoke_attempted_at = clock_timestamp(),
           revoke_outcome = NULL,
           updated_at = clock_timestamp()
       WHERE create_intent_id = $1
         AND state = 'revocation_pending'
         AND provider_key_hash = $2
         AND lease_id = $3
         AND lease_kind = 'revoke'
         AND lease_expires_at > clock_timestamp()
       RETURNING create_intent_id`,
      [leased.create_intent_id, leased.provider_key_hash, leaseId],
    );
    if (authorized.rowCount !== 1) {
      return pendingRevocationResult(leased);
    }

    let mutation: Awaited<ReturnType<OpenRouterManagementAdapter["disableKey"]>>;
    try {
      mutation = await adapter.disableKey(leased.provider_key_hash!);
    } catch {
      await recordPendingRevocation(client, leased, leaseId, "ambiguous");
      return pendingRevocationResult(leased);
    }
    let observed: "active" | "disabled" | "absent";
    try {
      observed = await observeProviderKey(adapter, leased.provider_key_hash!);
    } catch {
      await recordPendingRevocation(client, leased, leaseId, "ambiguous");
      return pendingRevocationResult(leased);
    }
    if (observed !== "active") {
      return markRevoked(client, leased, leaseId, observed);
    }
    await recordPendingRevocation(
      client,
      leased,
      leaseId,
      mutation.status === "rejected" ? "rejected" : "ambiguous",
    );
    if (mutation.status === "rejected") {
      return {
        status: "rejected",
        operation: "revoke",
        intentId: leased.create_intent_id,
        httpStatus: mutation.httpStatus,
      };
    }
    return pendingRevocationResult(leased);
  } finally {
    await releaseLease(client, leased.create_intent_id, leaseId);
  }
}

function pendingRevocationResult(
  row: HostedProviderKeyRow,
): Extract<HostedProviderKeyLifecycleResult, { status: "revocation-pending" }> {
  if (!row.provider_key_hash) {
    throw new Error("hosted provider revocation is missing its immutable hash");
  }
  return {
    status: "revocation-pending",
    intentId: row.create_intent_id,
    providerKeyHash: row.provider_key_hash,
  };
}

async function observeProviderKey(
  adapter: OpenRouterManagementAdapter,
  providerKeyHash: string,
): Promise<"active" | "disabled" | "absent"> {
  const lookup = await adapter.findKeyByHash(providerKeyHash);
  if (lookup.status === "absent") return "absent";
  return lookup.key.disabled ? "disabled" : "active";
}

async function markRevoked(
  client: PoolClient,
  row: HostedProviderKeyRow,
  leaseId: string,
  observed: "disabled" | "absent",
): Promise<Extract<HostedProviderKeyLifecycleResult, { status: "revoked" }>> {
  const result = await client.query(
    `UPDATE hosted_provider_keys
     SET state = 'revoked',
         revoke_outcome = $4,
         revoked_at = clock_timestamp(),
         reconciliation_required_at = NULL,
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND state = 'revocation_pending'
       AND provider_key_hash = $2
       AND lease_id = $3
       AND lease_kind = 'revoke'
       AND lease_expires_at > clock_timestamp()
     RETURNING create_intent_id`,
    [row.create_intent_id, row.provider_key_hash, leaseId, observed],
  );
  if (result.rowCount !== 1) {
    throw new Error("hosted provider revocation lost its durable lease");
  }
  return {
    status: "revoked",
    intentId: row.create_intent_id,
    providerKeyHash: row.provider_key_hash!,
    observed,
  };
}

async function recordPendingRevocation(
  client: PoolClient,
  row: HostedProviderKeyRow,
  leaseId: string,
  outcome: "ambiguous" | "rejected",
): Promise<void> {
  await client.query(
    `UPDATE hosted_provider_keys
     SET revoke_outcome = $3,
         reconciliation_required_at = clock_timestamp(),
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND state = 'revocation_pending'
       AND lease_id = $2
       AND lease_kind = 'revoke'`,
    [row.create_intent_id, leaseId, outcome],
  );
}

async function transitionCreateRejected(
  client: PoolClient,
  row: HostedProviderKeyRow,
  leaseId: string,
): Promise<void> {
  await client.query(
    `UPDATE hosted_provider_keys
     SET state = 'rejected',
         create_outcome = 'rejected',
         reconciliation_required_at = NULL,
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND state = 'provisioning'
       AND lease_id = $2
       AND lease_kind = 'create'`,
    [row.create_intent_id, leaseId],
  );
}

async function transitionToRevocationPending(
  client: PoolClient,
  intentId: string,
  leaseId: string,
  createOutcome: "created" | "credential_persistence_failed",
): Promise<void> {
  await client.query(
    `UPDATE hosted_provider_keys
     SET state = 'revocation_pending',
         sealed_runtime_key = NULL,
         create_outcome = $3,
         revocation_requested_at = clock_timestamp(),
         reconciliation_required_at = clock_timestamp(),
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND state = 'activating'
       AND lease_id = $2
       AND lease_kind = 'create'`,
    [intentId, leaseId, createOutcome],
  );
}

async function markOrphaned(
  client: PoolClient,
  row: HostedProviderKeyRow,
  leaseId: string,
  createOutcome:
    | "ambiguous"
    | "intent_changed"
    | "name_not_unique"
    | "name_present",
  conflictingProviderKeyHash: string | null,
): Promise<void> {
  await client.query(
    `UPDATE hosted_provider_keys
     SET state = 'orphaned',
         sealed_runtime_key = NULL,
         provider_key_hash = NULL,
         conflicting_provider_key_hash = $4,
         create_outcome = $3,
         reconciliation_required_at = clock_timestamp(),
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND lease_id = $2
       AND lease_kind = 'create'`,
    [row.create_intent_id, leaseId, createOutcome, conflictingProviderKeyHash],
  );
}

async function markOwnershipConflict(
  client: PoolClient,
  row: HostedProviderKeyRow,
  leaseId: string,
  providerKeyHash: string,
): Promise<void> {
  await client.query(
    `UPDATE hosted_provider_keys
     SET state = 'orphaned',
         sealed_runtime_key = NULL,
         provider_key_hash = NULL,
         conflicting_provider_key_hash = $3,
         create_outcome = 'ownership_conflict',
         reconciliation_required_at = clock_timestamp(),
         lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND lease_id = $2
       AND lease_kind = 'create'`,
    [row.create_intent_id, leaseId, providerKeyHash],
  );
}

async function readIntent(
  client: PoolClient,
  intentId: string,
): Promise<HostedProviderKeyRow | null> {
  const result = await client.query<HostedProviderKeyRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM hosted_provider_keys
     WHERE create_intent_id = $1`,
    [intentId],
  );
  return result.rows[0] ?? null;
}

async function releaseLease(
  client: PoolClient,
  intentId: string,
  leaseId: string,
): Promise<void> {
  await client.query(
    `UPDATE hosted_provider_keys
     SET lease_id = NULL,
         lease_kind = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE create_intent_id = $1
       AND lease_id = $2`,
    [intentId, leaseId],
  );
}

function validateLifecycleInput(input: LifecycleInput): void {
  if (!Number.isSafeInteger(input.orgId) || input.orgId <= 0) {
    throw new Error("hosted provider lifecycle organization id is invalid");
  }
  if (typeof input.sealRuntimeKey !== "function") {
    throw new Error("hosted provider lifecycle runtime-key sealer is required");
  }
}

const SELECT_COLUMNS = `
  create_intent_id, org_id, state, provider_key_name, provider_key_hash,
  conflicting_provider_key_hash, sealed_runtime_key,
  entitlement_period_starts_at, entitlement_period_ends_at,
  entitlement_updated_at, limit_micros, create_attempted_at, create_outcome,
  lease_id, lease_kind, lease_expires_at
`;

const RETURNING_COLUMNS = SELECT_COLUMNS;

const QUALIFIED_SELECT_COLUMNS = `
  h.create_intent_id, h.org_id, h.state, h.provider_key_name,
  h.provider_key_hash, h.conflicting_provider_key_hash,
  h.sealed_runtime_key, h.entitlement_period_starts_at,
  h.entitlement_period_ends_at, h.entitlement_updated_at, h.limit_micros,
  h.create_attempted_at, h.create_outcome, h.lease_id, h.lease_kind,
  h.lease_expires_at
`;
