import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  enqueueOperatorAlert,
  trialStartedAlertPayload,
} from "@/lib/operator-alerts";
import {
  HOSTED_INFERENCE_LOCK,
  HOSTED_TRIALS_PER_GITHUB_ACTOR,
} from "@/lib/release-job-rollout";

export const SELF_SERVICE_TRIAL_DAYS = 30;
const SELF_SERVICE_TRIAL_DURATION_MS =
  SELF_SERVICE_TRIAL_DAYS * 24 * 60 * 60 * 1_000;

// An internal service-protection ceiling, not a customer billing unit. The
// reservation layer remains fail-closed while ordinary trial usage has ample
// headroom.
export const SELF_SERVICE_TRIAL_HOSTED_USAGE_MICROS = 100_000_000;
export const SELF_SERVICE_HOSTED_TRIALS_PER_ACTOR = HOSTED_TRIALS_PER_GITHUB_ACTOR;

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

/** Grant one owner-scoped trial and enqueue its alert in the same transaction. */
export async function grantSelfServiceTrial(
  db: Database,
  input: SelfServiceTrialInput,
  now = new Date(),
): Promise<{ granted: boolean; trialEndsAt: Date | null }> {
  const trialEndsAt = new Date(now.getTime() + SELF_SERVICE_TRIAL_DURATION_MS);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${HOSTED_INFERENCE_LOCK}, 0))`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`postil:trial-actor:${input.initiatedByGithubId}`}, 0))`,
    );
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
    const hostedTrialCount = (
      await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.selfServiceTrialGrants)
        .where(
          and(
            eq(schema.selfServiceTrialGrants.initiatedByGithubId, input.initiatedByGithubId),
            eq(schema.selfServiceTrialGrants.grantedMode, "hosted"),
          ),
        )
    )[0]?.count ?? 0;
    const hostedEligible =
      input.subscriptionMode === "hosted" &&
      hostedAvailable &&
      hostedTrialCount < SELF_SERVICE_HOSTED_TRIALS_PER_ACTOR;
    const grantedMode = input.subscriptionMode === "hosted" && !hostedEligible
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
      console.warn(hostedAvailable
        ? `self-service hosted trial limit reached for GitHub actor ${input.initiatedByGithubId}`
        : `self-service hosted trial deferred until managed inference activation for GitHub actor ${input.initiatedByGithubId}`);
    }

    await enqueueOperatorAlert(
      tx,
      trialStartedAlertPayload({ ...input, trialEndsAt }),
    );

    return { granted: true, trialEndsAt };
  });
}
