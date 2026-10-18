import { closeDb, getDb, getPool } from "@/lib/db";
import { finalizeEscalationEmailRetirement } from "@/lib/escalation-email-retirement";
import {
  COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
  activateHostedInferenceRelease,
  activatePublicationLifecycleRelease,
  activatePrivateReviewAuthorIdentity,
  activateReleaseJobs,
  verifyPreparedCompatibleManagedRelease,
} from "@/lib/release-job-rollout";
import { hostedInferenceEnabled, optionalEnv } from "@/lib/env";
import { backfillSelfServiceTrials } from "@/lib/self-service-trial";
import { backfillBillingContactVerification } from "./backfill-billing-contact-verification";
import { checkedInReleaseMigrations } from "./run-release-migrations";

async function verifyRollingRelease(): Promise<void> {
  const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
  const sourceReleaseSha = optionalEnv("POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA");
  const protocol = optionalEnv("POSTIL_RELEASE_PROTOCOL");
  if (!releaseSha || !sourceReleaseSha) {
    throw new Error(
      "rolling release verification requires POSTIL_RELEASE_SHA and POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA",
    );
  }
  if (protocol !== COMPATIBLE_MANAGED_RELEASE_PROTOCOL) {
    throw new Error(
      `POSTIL_RELEASE_PROTOCOL must be ${COMPATIBLE_MANAGED_RELEASE_PROTOCOL}`,
    );
  }
  await verifyPreparedCompatibleManagedRelease(
    getPool(),
    sourceReleaseSha,
    releaseSha,
    protocol,
    checkedInReleaseMigrations(),
  );
  console.log(`compatible rolling release verified: release=${releaseSha}`);
}

async function runHistoricMaintenance(): Promise<void> {
  // This path mutates historic state and is never an automatic release fallback.
  const retirement = await finalizeEscalationEmailRetirement(getPool());
  const billing = await backfillBillingContactVerification(getDb(), {
    confirm: true,
  });
  const privateReviewAuthorActivated =
    await activatePrivateReviewAuthorIdentity(getPool());
  const publicationLifecycle =
    await activatePublicationLifecycleRelease(getPool());
  const released = await activateReleaseJobs(getPool());
  const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
  const hostedInferenceActivated = releaseSha
    ? await activateHostedInferenceRelease(getPool(), releaseSha)
    : null;
  const selfServiceTrials = releaseSha
    ? await backfillSelfServiceTrials(getDb(), {
        hostedInferenceEnabled: hostedInferenceEnabled(),
        releaseSha,
      })
    : { eligible: 0, granted: 0 };
  console.log(
    `release maintenance completed: released=${released} ` +
      `private_review_author=${privateReviewAuthorActivated ? "activated" : "already_active"} ` +
      `publication_lifecycle=${publicationLifecycle.activated ? "activated" : "already_active"} ` +
      `publication_lifecycle_recoveries_queued=${publicationLifecycle.recoveriesQueued} ` +
      `publication_lifecycle_running_gates_recovered=${publicationLifecycle.runningGatesRecovered} ` +
      `publication_lifecycle_released=${publicationLifecycle.released} ` +
      `hosted_inference=${hostedInferenceActivated === null ? "unmanaged" : hostedInferenceActivated ? "activated" : "already_active"} ` +
      `self_service_trials_eligible=${selfServiceTrials.eligible} ` +
      `self_service_trials_granted=${selfServiceTrials.granted} ` +
      `billing_pending=${billing.pending} billing_queued=${billing.queued} ` +
      `escalation_terminalized=${retirement.terminalized} ` +
      `escalation_redacted=${retirement.redacted} ` +
      `escalation_recipients_cleared=${retirement.clearedOrganizations}`,
  );
}

export function releaseActivationMode(
  argument: string | undefined,
  environment: Record<string, string | undefined> = process.env,
): "rolling" | "maintenance" {
  const managed = environment.POSTIL_MANAGED_RELEASE;
  if (managed !== undefined && managed !== "0" && managed !== "1") {
    throw new Error("POSTIL_MANAGED_RELEASE must be 0 or 1");
  }
  if (argument === undefined) return managed === "1" ? "rolling" : "maintenance";
  if (argument === "--rolling") return "rolling";
  if (argument === "--maintenance") return "maintenance";
  throw new Error("release activation accepts only --rolling or --maintenance");
}

async function main(): Promise<void> {
  try {
    if (process.argv.length > 3) throw new Error("release activation accepts one mode argument");
    const mode = releaseActivationMode(process.argv[2]);
    if (mode === "maintenance") await runHistoricMaintenance();
    else await verifyRollingRelease();
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
