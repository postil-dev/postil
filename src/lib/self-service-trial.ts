import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  enqueueOperatorAlert,
  trialStartedAlertPayload,
} from "@/lib/operator-alerts";

export const SELF_SERVICE_TRIAL_DAYS = 30;
const SELF_SERVICE_TRIAL_DURATION_MS =
  SELF_SERVICE_TRIAL_DAYS * 24 * 60 * 60 * 1_000;

// An internal service-protection ceiling, not a customer billing unit. The
// reservation layer remains fail-closed while ordinary trial usage has ample
// headroom.
export const SELF_SERVICE_TRIAL_HOSTED_USAGE_MICROS = 100_000_000;

type TrialWriteDatabase = Pick<Database, "insert">;

export interface SelfServiceTrialInput {
  orgId: number;
  orgSlug: string;
  accountLogin: string;
  accountType: string;
  githubOwnerId: number;
  githubInstallationId: number;
  subscriptionMode: "hosted" | "byok";
}

/** Grant one owner-scoped trial and enqueue its alert in the same transaction. */
export async function grantSelfServiceTrial(
  db: TrialWriteDatabase,
  input: SelfServiceTrialInput,
  now = new Date(),
): Promise<{ granted: boolean; trialEndsAt: Date | null }> {
  const trialEndsAt = new Date(now.getTime() + SELF_SERVICE_TRIAL_DURATION_MS);
  const [created] = await db
    .insert(schema.organizationEntitlements)
    .values({
      orgId: input.orgId,
      subscriptionMode: input.subscriptionMode,
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

  await enqueueOperatorAlert(
    db,
    trialStartedAlertPayload({ ...input, trialEndsAt }),
  );

  return { granted: true, trialEndsAt };
}
