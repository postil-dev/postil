import { and, eq } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import {
  configuredGithubWebBase,
  sendHumanEscalationNotification,
} from "@/lib/escalation-notification";
import type { Envelope } from "@/lib/envelope";
import { requireEnv } from "@/lib/env";
import { optionalEnv } from "@/lib/env";

export interface EscalationNotificationJobPayload extends Record<string, unknown> {
  reviewId: number;
  reviewPublicId: string;
  repoFullName: string;
  prNumber: number;
  runUrl: string;
}

export async function runEscalationNotificationJob(
  payload: EscalationNotificationJobPayload,
): Promise<void> {
  validatePayload(payload);
  const row = (
    await getDb()
      .select({
        status: schema.reviews.status,
        publicId: schema.reviews.publicId,
        envelope: schema.reviews.envelope,
        escalationEmail: schema.orgSettings.escalationEmail,
        orgSlug: schema.organizations.slug,
      })
      .from(schema.reviews)
      .innerJoin(
        schema.repositories,
        eq(schema.repositories.id, schema.reviews.repositoryId),
      )
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .leftJoin(
        schema.orgSettings,
        eq(schema.orgSettings.orgId, schema.installations.orgId),
      )
      .leftJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.installations.orgId),
      )
      .where(
        and(
          eq(schema.reviews.id, payload.reviewId),
          eq(schema.reviews.publicId, payload.reviewPublicId),
        ),
      )
      .limit(1)
  )[0];
  if (!row || row.status !== "completed" || !row.envelope) {
    throw new Error("escalation notification review is missing or incomplete");
  }
  const bootstrapOrg = optionalEnv("POSTIL_ESCALATION_ORG");
  const bootstrapEmail = optionalEnv("POSTIL_ESCALATION_EMAIL");
  const recipient =
    row.escalationEmail?.trim() ||
    (bootstrapOrg && row.orgSlug === bootstrapOrg ? bootstrapEmail?.trim() : undefined);
  if (!recipient) {
    throw new Error("organization escalation email is not configured");
  }

  const result = await sendHumanEscalationNotification({
    envelope: row.envelope as Envelope,
    repoFullName: payload.repoFullName,
    prNumber: payload.prNumber,
    runUrl: payload.runUrl,
    reviewPublicId: payload.reviewPublicId,
    recipient,
    apiKey: requireEnv("BREVO_API_KEY"),
    githubWebBase: configuredGithubWebBase(),
  });
  if (!result.sent) {
    console.log(
      `escalation notification ${payload.reviewPublicId} had no new qualifying findings`,
    );
  }
}

function validatePayload(payload: EscalationNotificationJobPayload): void {
  if (
    !Number.isInteger(payload.reviewId) ||
    typeof payload.reviewPublicId !== "string" ||
    typeof payload.repoFullName !== "string" ||
    !Number.isInteger(payload.prNumber) ||
    typeof payload.runUrl !== "string"
  ) {
    throw new Error("escalation notification job payload is malformed");
  }
}
