import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  enqueueCustomerNotification,
  trialStartedNotification,
} from "@/lib/customer-notifications";
import {
  enqueueOperatorAlert,
  trialStartedAlertPayload,
} from "@/lib/operator-alerts";
import {
  HOSTED_INFERENCE_LOCK,
  hostedInferenceCapability,
} from "@/lib/release-job-rollout";

export const SELF_SERVICE_TRIAL_DAYS = 30;
const SELF_SERVICE_TRIAL_DURATION_MS =
  SELF_SERVICE_TRIAL_DAYS * 24 * 60 * 60 * 1_000;

// An internal service-protection ceiling, not a customer billing unit. The
// reservation layer remains fail-closed while ordinary trial usage has ample
// headroom.
export const SELF_SERVICE_TRIAL_HOSTED_USAGE_MICROS = 100_000_000;

export interface SelfServiceTrialInput {
  orgId: number;
  orgSlug: string;
  accountLogin: string;
  accountType: string;
  githubOwnerId: number;
  githubInstallationId: number;
  initiatedByGithubId: number;
  subscriptionMode: "hosted" | "byok";
  hostedInferenceEnabled: boolean;
  hostedReleaseCapability: string | null;
}

export interface SelfServiceTrialBackfillInput {
  hostedInferenceEnabled: boolean;
  releaseSha: string;
}

async function lockHostedInferenceRelease(
  db: Pick<Database, "execute">,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${HOSTED_INFERENCE_LOCK}, 0))`,
  );
}

/**
 * Grant one account-scoped trial and enqueue its alert in the same transaction.
 *
 * A trial belongs to the installation account, so each organization gets one
 * and the entitlement's org uniqueness is the whole limit. The installing
 * identity is recorded but never capped: the same person can be an owner on one
 * account and a maintainer on several others whose owners installed Postil
 * independently, and denying those accounts a trial would penalize the member
 * rather than the account that is actually trialing.
 */
export async function grantSelfServiceTrial(
  db: Database,
  input: SelfServiceTrialInput,
  now = new Date(),
): Promise<{ granted: boolean; trialEndsAt: Date | null }> {
  const trialEndsAt = new Date(now.getTime() + SELF_SERVICE_TRIAL_DURATION_MS);
  return db.transaction(async (tx) => {
    await lockHostedInferenceRelease(tx);
    const capability = input.hostedReleaseCapability
      ? await tx.execute(sql`
          SELECT EXISTS (
            SELECT 1 FROM deployment_capabilities
            WHERE name = ${input.hostedReleaseCapability}
          ) AS active
        `)
      : null;
    const hostedAvailable =
      input.hostedInferenceEnabled &&
      (capability === null || capability.rows[0]?.active === true);
    const hostedEligible = input.subscriptionMode === "hosted" && hostedAvailable;
    const grantedMode =
      input.subscriptionMode === "hosted" && !hostedEligible
        ? "byok"
        : input.subscriptionMode;
    const [created] = await tx
      .insert(schema.organizationEntitlements)
      .values({
        orgId: input.orgId,
        subscriptionMode: grantedMode,
        status: "trialing",
        trialEndsAt,
        periodStartsAt: now,
        periodEndsAt: trialEndsAt,
        includedUsageMicros: SELF_SERVICE_TRIAL_HOSTED_USAGE_MICROS,
        overageHardCapMicros: 0,
        includedUsageCents: SELF_SERVICE_TRIAL_HOSTED_USAGE_MICROS / 10_000,
        overageHardCapCents: 0,
        updatedBy: "self-service-trial",
        updatedAt: now,
      })
      .onConflictDoNothing({ target: schema.organizationEntitlements.orgId })
      .returning({ orgId: schema.organizationEntitlements.orgId });

    if (!created) return { granted: false, trialEndsAt: null };

    await tx.insert(schema.selfServiceTrialGrants).values({
      orgId: input.orgId,
      initiatedByGithubId: input.initiatedByGithubId,
      requestedMode: input.subscriptionMode,
      grantedMode,
      createdAt: now,
    });
    if (grantedMode !== input.subscriptionMode) {
      console.warn(
        `self-service hosted trial deferred until managed inference activation for organization ${input.orgId}`,
      );
    }

    await enqueueOperatorAlert(
      tx,
      trialStartedAlertPayload({ ...input, trialEndsAt }),
    );
    await enqueueCustomerNotification(
      tx,
      trialStartedNotification({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        githubOwnerId: input.githubOwnerId,
      }),
      now,
    );

    return { granted: true, trialEndsAt };
  });
}

/**
 * Grant trials to unentitled personal installations and repair active legacy
 * self-service trials that were recorded as BYOK without provider credentials.
 * The immutable grant keeps release activation and repeated deploys idempotent.
 */
export async function backfillSelfServiceTrials(
  db: Database,
  input: SelfServiceTrialBackfillInput,
): Promise<{ eligible: number; granted: number }> {
  const now = new Date();
  const selection = {
    orgId: schema.organizations.id,
    orgSlug: schema.organizations.slug,
    githubOwnerId: schema.organizations.githubOrgId,
    accountLogin: schema.installations.accountLogin,
    accountType: schema.installations.accountType,
    githubInstallationId: schema.installations.githubInstallationId,
  };
  const unentitled = await db
    .selectDistinctOn([schema.organizations.id], {
      ...selection,
    })
    .from(schema.installations)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.installations.orgId),
    )
    .leftJoin(
      schema.organizationEntitlements,
      eq(schema.organizationEntitlements.orgId, schema.organizations.id),
    )
    .leftJoin(
      schema.selfServiceTrialGrants,
      eq(schema.selfServiceTrialGrants.orgId, schema.organizations.id),
    )
    .where(
      and(
        eq(schema.installations.accountType, "User"),
        eq(schema.installations.suspended, false),
        isNotNull(schema.organizations.githubOrgId),
        isNull(schema.organizationEntitlements.orgId),
        isNull(schema.selfServiceTrialGrants.orgId),
      ),
    )
    .orderBy(schema.organizations.id, desc(schema.installations.id));
  const unrecorded = await db
    .selectDistinctOn([schema.organizations.id], {
      ...selection,
      trialEndsAt: schema.organizationEntitlements.trialEndsAt,
    })
    .from(schema.installations)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.installations.orgId),
    )
    .innerJoin(
      schema.organizationEntitlements,
      eq(schema.organizationEntitlements.orgId, schema.organizations.id),
    )
    .leftJoin(
      schema.selfServiceTrialGrants,
      eq(schema.selfServiceTrialGrants.orgId, schema.organizations.id),
    )
    .leftJoin(
      schema.orgSettings,
      eq(schema.orgSettings.orgId, schema.organizations.id),
    )
    .where(
      and(
        eq(schema.installations.suspended, false),
        isNotNull(schema.organizations.githubOrgId),
        eq(schema.organizationEntitlements.subscriptionMode, "byok"),
        eq(schema.organizationEntitlements.status, "trialing"),
        eq(schema.organizationEntitlements.updatedBy, "self-service-trial"),
        gt(schema.organizationEntitlements.trialEndsAt, now),
        isNull(schema.orgSettings.apiKeyCiphertext),
        isNull(schema.selfServiceTrialGrants.orgId),
      ),
    )
    .orderBy(schema.organizations.id, desc(schema.installations.id));

  let granted = 0;
  const capability = hostedInferenceCapability(input.releaseSha);
  for (const candidate of unentitled) {
    if (candidate.githubOwnerId === null) continue;
    const result = await grantSelfServiceTrial(
      db,
      {
        ...candidate,
        githubOwnerId: candidate.githubOwnerId,
        initiatedByGithubId: candidate.githubOwnerId,
        subscriptionMode: "hosted",
        hostedInferenceEnabled: input.hostedInferenceEnabled,
        hostedReleaseCapability: capability,
      },
      now,
    );
    if (result.granted) granted += 1;
  }

  for (const candidate of unrecorded) {
    if (candidate.githubOwnerId === null || candidate.trialEndsAt === null)
      continue;
    const githubOwnerId = candidate.githubOwnerId;
    const trialEndsAt = candidate.trialEndsAt;
    const created = await db.transaction(async (tx) => {
      await lockHostedInferenceRelease(tx);
      const inserted = await tx
        .insert(schema.selfServiceTrialGrants)
        .values({
          orgId: candidate.orgId,
          initiatedByGithubId: githubOwnerId,
          requestedMode: "hosted",
          grantedMode: "byok",
          createdAt: now,
        })
        .onConflictDoNothing({ target: schema.selfServiceTrialGrants.orgId })
        .returning({ orgId: schema.selfServiceTrialGrants.orgId });
      if (inserted.length === 0) return false;
      await enqueueOperatorAlert(
        tx,
        trialStartedAlertPayload({ ...candidate, githubOwnerId, trialEndsAt }),
      );
      return true;
    });
    if (created) granted += 1;
  }

  return {
    eligible: unentitled.length + unrecorded.length,
    granted,
  };
}
