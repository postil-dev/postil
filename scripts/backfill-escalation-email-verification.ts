import { and, eq, inArray, isNull } from "drizzle-orm";

import { closeDb, getDb, schema, type Database } from "@/lib/db";
import {
  createEscalationEmailVerification,
  escalationEmailVerificationJobPayload,
} from "@/lib/escalation-email-verification";

export interface BackfillResult {
  pending: number;
  queued: number;
  alreadyQueued: number;
  dryRun: boolean;
}

export async function backfillEscalationEmailVerification(
  db: Database,
  options: { confirm: boolean; now?: Date },
): Promise<BackfillResult> {
  const now = options.now ?? new Date();
  const rows = await db
    .select({
      orgId: schema.orgSettings.orgId,
      pendingEmail: schema.orgSettings.escalationEmailPending,
      tokenDigest: schema.orgSettings.escalationEmailVerificationTokenDigest,
      tokenCiphertext:
        schema.orgSettings.escalationEmailVerificationTokenCiphertext,
      expiresAt: schema.orgSettings.escalationEmailVerificationExpiresAt,
      sentAt: schema.orgSettings.escalationEmailVerificationSentAt,
    })
    .from(schema.orgSettings);
  const liveJobs = await db
    .select({ payload: schema.jobs.payload })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.kind, "escalation-email-verification"),
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
      row.tokenDigest &&
        row.tokenCiphertext &&
        row.expiresAt &&
        row.expiresAt > now,
    );
    if (!validToken) return true;
    if (row.sentAt) return false;
    const key = `${row.orgId}:${row.tokenDigest!.toString("base64url")}`;
    return !liveJobKeys.has(key);
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
      row.tokenDigest &&
        row.tokenCiphertext &&
        row.expiresAt &&
        row.expiresAt > now,
    );
    if (reusableToken) {
      const inserted = await db
        .insert(schema.jobs)
        .values({
          kind: "escalation-email-verification",
          payload: escalationEmailVerificationJobPayload(row.orgId, row.tokenDigest!),
          maxAttempts: 5,
        })
        .returning({ id: schema.jobs.id });
      queued += inserted.length;
      continue;
    }
    const verification = createEscalationEmailVerification(
      row.orgId,
      pendingEmail,
      now,
    );
    const inserted = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.orgSettings)
        .set({
          escalationEmailVerificationTokenDigest: verification.tokenDigest,
          escalationEmailVerificationTokenCiphertext: verification.tokenCiphertext,
          escalationEmailVerificationExpiresAt: verification.expiresAt,
          escalationEmailVerificationRequestedAt: verification.requestedAt,
          escalationEmailVerificationSentAt: null,
          escalationEmailVerificationMessageId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.orgSettings.orgId, row.orgId),
            eq(schema.orgSettings.escalationEmailPending, pendingEmail),
            row.tokenDigest
              ? eq(
                  schema.orgSettings.escalationEmailVerificationTokenDigest,
                  row.tokenDigest,
                )
              : isNull(schema.orgSettings.escalationEmailVerificationTokenDigest),
          ),
        )
        .returning({ orgId: schema.orgSettings.orgId });
      if (updated.length !== 1) return false;
      const job = await tx
        .insert(schema.jobs)
        .values({
          kind: "escalation-email-verification",
          payload: escalationEmailVerificationJobPayload(
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
  if (args.has("--help") || args.has("-h")) {
    console.log(
      "Usage: bun run notifications:backfill-verification --dry-run | --confirm",
    );
    return;
  }
  const confirm = args.has("--confirm");
  const dryRun = args.has("--dry-run");
  if (confirm === dryRun || args.size !== 1) {
    throw new Error("choose exactly one of --dry-run or --confirm");
  }
  try {
    const result = await backfillEscalationEmailVerification(getDb(), { confirm });
    console.log(
      `${result.dryRun ? "Dry run" : "Backfill complete"}: pending=${result.pending} queued=${result.queued} already_queued=${result.alreadyQueued}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  await main();
}
