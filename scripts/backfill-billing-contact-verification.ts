import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  billingContactVerificationJobPayload,
  createBillingContactVerification,
} from "@/lib/billing-contact-verification";
import { closeDb, getDb, schema, type Database } from "@/lib/db";

export interface BillingContactBackfillResult {
  pending: number;
  queued: number;
  alreadyQueued: number;
  dryRun: boolean;
}

export async function backfillBillingContactVerification(
  db: Database,
  options: { confirm: boolean; now?: Date },
): Promise<BillingContactBackfillResult> {
  const now = options.now ?? new Date();
  const rows = await db
    .select({
      orgId: schema.organizationEntitlements.orgId,
      pendingEmail: schema.organizationEntitlements.billingContactPending,
      tokenDigest: schema.organizationEntitlements.billingContactVerificationTokenDigest,
      tokenCiphertext:
        schema.organizationEntitlements.billingContactVerificationTokenCiphertext,
      expiresAt: schema.organizationEntitlements.billingContactVerificationExpiresAt,
      sentAt: schema.organizationEntitlements.billingContactVerificationSentAt,
    })
    .from(schema.organizationEntitlements);
  const liveJobs = await db
    .select({ payload: schema.jobs.payload })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.kind, "billing-contact-verification"),
        inArray(schema.jobs.status, ["queued", "running"]),
      ),
    );
  const liveJobKeys = new Set(
    liveJobs.flatMap((job) => {
      const orgId = job.payload.orgId;
      const digest = job.payload.tokenDigest;
      return Number.isSafeInteger(orgId) && typeof digest === "string"
        ? [`${orgId}:${digest}`]
        : [];
    }),
  );
  const pending = rows.filter((row) => Boolean(row.pendingEmail));
  const needsQueue = pending.filter((row) => {
    const validToken = Boolean(
      row.tokenDigest && row.tokenCiphertext && row.expiresAt && row.expiresAt > now,
    );
    if (!validToken) return true;
    if (row.sentAt) return false;
    return !liveJobKeys.has(`${row.orgId}:${row.tokenDigest!.toString("base64url")}`);
  });
  if (!options.confirm) {
    return {
      pending: pending.length,
      queued: 0,
      alreadyQueued: pending.length - needsQueue.length,
      dryRun: true,
    };
  }

  let queued = 0;
  for (const row of needsQueue) {
    if (!row.pendingEmail) continue;
    const pendingEmail = row.pendingEmail;
    const reusableToken = Boolean(
      row.tokenDigest && row.tokenCiphertext && row.expiresAt && row.expiresAt > now,
    );
    if (reusableToken) {
      const inserted = await db
        .insert(schema.jobs)
        .values({
          kind: "billing-contact-verification",
          payload: billingContactVerificationJobPayload(row.orgId, row.tokenDigest!),
          maxAttempts: 5,
        })
        .returning({ id: schema.jobs.id });
      queued += inserted.length;
      continue;
    }
    const verification = createBillingContactVerification(row.orgId, pendingEmail, now);
    const inserted = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.organizationEntitlements)
        .set({
          billingContactVerificationTokenDigest: verification.tokenDigest,
          billingContactVerificationTokenCiphertext: verification.tokenCiphertext,
          billingContactVerificationExpiresAt: verification.expiresAt,
          billingContactVerificationRequestedAt: verification.requestedAt,
          billingContactVerificationSentAt: null,
          billingContactVerificationMessageId: null,
          updatedBy: "billing-contact-verification-backfill",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.organizationEntitlements.orgId, row.orgId),
            eq(schema.organizationEntitlements.billingContactPending, pendingEmail),
            row.tokenDigest
              ? eq(
                  schema.organizationEntitlements.billingContactVerificationTokenDigest,
                  row.tokenDigest,
                )
              : isNull(schema.organizationEntitlements.billingContactVerificationTokenDigest),
          ),
        )
        .returning({ orgId: schema.organizationEntitlements.orgId });
      if (updated.length !== 1) return false;
      const job = await tx
        .insert(schema.jobs)
        .values({
          kind: "billing-contact-verification",
          payload: billingContactVerificationJobPayload(
            row.orgId,
            verification.tokenDigest,
          ),
          maxAttempts: 5,
        })
        .returning({ id: schema.jobs.id });
      return job.length === 1;
    });
    if (inserted) queued += 1;
  }
  return {
    pending: pending.length,
    queued,
    alreadyQueued: pending.length - needsQueue.length,
    dryRun: false,
  };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const confirm = args.has("--confirm");
  const dryRun = args.has("--dry-run");
  if (confirm === dryRun || args.size !== 1) {
    throw new Error("choose exactly one of --dry-run or --confirm");
  }
  try {
    const result = await backfillBillingContactVerification(getDb(), { confirm });
    console.log(
      `${result.dryRun ? "Dry run" : "Backfill complete"}: pending=${result.pending} queued=${result.queued} already_queued=${result.alreadyQueued}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
