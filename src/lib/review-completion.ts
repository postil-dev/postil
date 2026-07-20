import { and, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import type { Envelope } from "@/lib/envelope";
import type { ReviewConfigProvenance } from "@/lib/github/contents";
import {
  persistPublicationReceipt,
  type PublicationReceipt,
} from "@/lib/publication-receipt";

export interface ReviewCompletionInput {
  reviewId: number;
  envelope: Envelope;
  configFiles: string[];
  configProvenance?: ReviewConfigProvenance;
  silent: boolean;
  gateFailing: boolean;
  usage: Array<{
    orgId: number | null;
    repositoryId: number;
    promptTokens: number;
    completionTokens: number;
    modelUsed: string;
    costMicros: number | null;
    billingScope: "analytics" | "private_hosted";
  }>;
  hostedUsageReservationId?: string | null;
  usageAccountingComplete: boolean;
  publicationReceipt?: PublicationReceipt;
}

/**
 * Persist the terminal review and its accounting atomically.
 */
export async function persistReviewCompletion(
  db: Database,
  input: ReviewCompletionInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.reviews)
      .set({
        status: "completed",
        envelope: input.envelope,
        configFiles: input.configFiles,
        configProvenance: input.configProvenance ?? { entries: [], degraded: false },
        silent: input.silent,
        engineGateFailing: input.gateFailing,
        gateFailing: input.gateFailing,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.reviews.id, input.reviewId),
          eq(schema.reviews.status, "running"),
        ),
      )
      .returning({
        id: schema.reviews.id,
        triggerSource: schema.reviews.triggerSource,
      });
    if (rows.length === 0) return false;

    await persistPublicationReceipt(tx as Database, {
      reviewId: input.reviewId,
      envelope: input.envelope,
      receipt: input.publicationReceipt,
    });

    const persistedUsageRows = input.usage.map((usage) => ({
      ...usage,
      reviewId: input.reviewId,
      triggerSource: rows[0]!.triggerSource,
    }));
    if (input.hostedUsageReservationId) {
      const reservation = (
        await tx
          .select({ reservedMicros: schema.hostedUsageReservations.reservedMicros })
          .from(schema.hostedUsageReservations)
          .where(eq(schema.hostedUsageReservations.id, input.hostedUsageReservationId))
          .limit(1)
      )[0];
      if (!reservation) throw new Error("hosted usage reservation not found");
      const priced = input.usage.every((usage) => usage.costMicros !== null);
      const knownMicros = input.usage.reduce(
        (total, usage) => total + (usage.costMicros ?? 0),
        0,
      );
      // A private hosted event must never retain NULL cost: reservation
      // accounting interprets any NULL as an unknown full-period spend. Keep
      // the model/token analytics at zero and charge uncertainty explicitly.
      for (const usage of persistedUsageRows) {
        if (usage.billingScope === "private_hosted" && usage.costMicros === null) {
          usage.costMicros = 0;
        }
      }
      const actualMicros = input.usageAccountingComplete && priced
        ? knownMicros
        : Math.max(reservation.reservedMicros, knownMicros);
      const unattributedMicros = actualMicros - knownMicros;
      if (unattributedMicros > 0) {
        const first = input.usage[0];
        if (!first) throw new Error("hosted review usage is empty");
        persistedUsageRows.push({
          ...first,
          promptTokens: 0,
          completionTokens: 0,
          modelUsed: "unattributed provider usage",
          costMicros: unattributedMicros,
          reviewId: input.reviewId,
          triggerSource: rows[0]!.triggerSource,
        });
      }
      const reconciled = await tx
        .update(schema.hostedUsageReservations)
        .set({ status: "reconciled", actualMicros, updatedAt: new Date() })
        .where(
          and(
            eq(schema.hostedUsageReservations.id, input.hostedUsageReservationId),
            eq(schema.hostedUsageReservations.status, "active"),
          ),
        )
        .returning({ id: schema.hostedUsageReservations.id });
      if (reconciled.length !== 1) {
        throw new Error("hosted usage reservation is not active");
      }
    }
    await tx.insert(schema.usageEvents).values(persistedUsageRows);
    return true;
  });
}
