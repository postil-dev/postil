import { closeDb, getDb, getPool } from "@/lib/db";
import { activateReleaseJobs } from "@/lib/release-job-rollout";
import { backfillBillingContactVerification } from "./backfill-billing-contact-verification";
import { backfillEscalationEmailVerification } from "./backfill-escalation-email-verification";

async function main(): Promise<void> {
  try {
    // Backfill first. Migration 0020 holds all release-v1 job kinds at infinity
    // until activation, so a retry or partial failure cannot expose them to an
    // old consumer. Activation is idempotent and releases all staged jobs.
    const escalation = await backfillEscalationEmailVerification(getDb(), {
      confirm: true,
    });
    const billing = await backfillBillingContactVerification(getDb(), {
      confirm: true,
    });
    const released = await activateReleaseJobs(getPool());
    console.log(
      `release job kinds activated: released=${released} ` +
        `escalation_pending=${escalation.pending} escalation_queued=${escalation.queued} ` +
        `billing_pending=${billing.pending} billing_queued=${billing.queued}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
