import { closeDb, getDb, getPool } from "@/lib/db";
import { finalizeEscalationEmailRetirement } from "@/lib/escalation-email-retirement";
import {
  activateHostedInferenceRelease,
  activatePrivateReviewAuthorIdentity,
  activateReleaseJobs,
} from "@/lib/release-job-rollout";
import { hostedInferenceEnabled, optionalEnv } from "@/lib/env";
import { backfillExistingPersonalAccountTrials } from "@/lib/self-service-trial";
import { backfillBillingContactVerification } from "./backfill-billing-contact-verification";

async function main(): Promise<void> {
  try {
    // Retire escalation email state before unrelated release activation work.
    // Migration 0020 holds all release-v1 job kinds at infinity until the
    // homogeneous fleet check completes. Every operation is idempotent.
    const retirement = await finalizeEscalationEmailRetirement(getPool());
    const billing = await backfillBillingContactVerification(getDb(), {
      confirm: true,
    });
    const privateReviewAuthorActivated =
      await activatePrivateReviewAuthorIdentity(getPool());
    const released = await activateReleaseJobs(getPool());
    const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
    const personalTrials = releaseSha
      ? await backfillExistingPersonalAccountTrials(getDb(), {
          hostedInferenceEnabled: hostedInferenceEnabled(),
          releaseSha,
        })
      : { eligible: 0, granted: 0 };
    const hostedInferenceActivated = releaseSha
      ? await activateHostedInferenceRelease(getPool(), releaseSha)
      : null;
    console.log(
      `release job kinds activated: released=${released} ` +
        `private_review_author=${privateReviewAuthorActivated ? "activated" : "already_active"} ` +
        `hosted_inference=${hostedInferenceActivated === null ? "unmanaged" : hostedInferenceActivated ? "activated" : "already_active"} ` +
        `personal_trials_eligible=${personalTrials.eligible} ` +
        `personal_trials_granted=${personalTrials.granted} ` +
        `billing_pending=${billing.pending} billing_queued=${billing.queued} ` +
        `escalation_terminalized=${retirement.terminalized} ` +
        `escalation_redacted=${retirement.redacted} ` +
        `escalation_recipients_cleared=${retirement.clearedOrganizations}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
