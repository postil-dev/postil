import { sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";

export type RepoHealth =
  | "healthy"
  | "awaiting-first-pr"
  | "never-reviewed"
  | "failing";

export type RepoHealthReviewStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stale";

export interface RepoHealthRow {
  repositoryId: number;
  repositoryFullName: string;
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
  lastEnabledAt: Date;
  installationSuspended: boolean;
  attemptCount: number;
  completedCount: number;
  lastCompletedAt: Date | null;
  latestAttemptStatus: RepoHealthReviewStatus | null;
  latestAttemptAt: Date | null;
  latestAttemptPublicId: string | null;
}

interface RawRepoHealthRow
  extends Omit<RepoHealthRow, "lastEnabledAt" | "lastCompletedAt" | "latestAttemptAt"> {
  lastEnabledAt: Date | string;
  lastCompletedAt: Date | string | null;
  latestAttemptAt: Date | string | null;
}

type RepoHealthDatabase = Pick<Database, "execute">;

const NEVER_REVIEWED_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const PENDING_REVIEW_STALE_AFTER_MS = 60 * 60 * 1_000;

/**
 * Load health inputs for every enabled repository in an organization in one
 * database round trip. Review aggregates are scoped to the repository's most
 * recent enablement, so an earlier lifecycle cannot mask a broken re-enable.
 */
export async function getRepoHealthRows(
  db: RepoHealthDatabase,
  orgId: number,
): Promise<RepoHealthRow[]> {
  const result = await db.execute(sql<RepoHealthRow>`
    SELECT
      ${schema.repositories.id}::float8 AS "repositoryId",
      ${schema.repositories.fullName} AS "repositoryFullName",
      ${schema.installations.githubInstallationId}::float8 AS "githubInstallationId",
      ${schema.installations.accountLogin} AS "accountLogin",
      ${schema.installations.accountType} AS "accountType",
      COALESCE(enablement."lastEnabledAt", ${schema.repositories.createdAt}) AS "lastEnabledAt",
      ${schema.installations.suspended} AS "installationSuspended",
      COALESCE(review_stats."attemptCount", 0)::int AS "attemptCount",
      COALESCE(review_stats."completedCount", 0)::int AS "completedCount",
      review_stats."lastCompletedAt" AS "lastCompletedAt",
      latest_review."status" AS "latestAttemptStatus",
      COALESCE(
        latest_review."finishedAt",
        latest_review."startedAt",
        latest_review."queuedAt"
      ) AS "latestAttemptAt",
      latest_review."publicId"::text AS "latestAttemptPublicId"
    FROM ${schema.repositories}
    INNER JOIN ${schema.installations}
      ON ${schema.installations.id} = ${schema.repositories.installationId}
    LEFT JOIN LATERAL (
      SELECT MAX(${schema.repositoryEnablementEvents.occurredAt}) AS "lastEnabledAt"
      FROM ${schema.repositoryEnablementEvents}
      WHERE ${schema.repositoryEnablementEvents.repositoryId} = ${schema.repositories.id}
        AND ${schema.repositoryEnablementEvents.orgId} = ${orgId}
        AND ${schema.repositoryEnablementEvents.action} = 'enable'
    ) enablement ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS "attemptCount",
        COUNT(*) FILTER (WHERE ${schema.reviews.status} = 'completed')::int AS "completedCount",
        MAX(${schema.reviews.finishedAt})
          FILTER (WHERE ${schema.reviews.status} = 'completed') AS "lastCompletedAt"
      FROM ${schema.reviews}
      WHERE ${schema.reviews.repositoryId} = ${schema.repositories.id}
        AND ${schema.reviews.queuedAt} >= COALESCE(
          enablement."lastEnabledAt",
          ${schema.repositories.createdAt}
        )
    ) review_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        ${schema.reviews.status} AS "status",
        ${schema.reviews.publicId} AS "publicId",
        ${schema.reviews.queuedAt} AS "queuedAt",
        ${schema.reviews.startedAt} AS "startedAt",
        ${schema.reviews.finishedAt} AS "finishedAt"
      FROM ${schema.reviews}
      WHERE ${schema.reviews.repositoryId} = ${schema.repositories.id}
        AND ${schema.reviews.queuedAt} >= COALESCE(
          enablement."lastEnabledAt",
          ${schema.repositories.createdAt}
        )
      ORDER BY ${schema.reviews.queuedAt} DESC, ${schema.reviews.id} DESC
      LIMIT 1
    ) latest_review ON true
    WHERE ${schema.installations.orgId} = ${orgId}
      AND ${schema.repositories.enabled} = true
    ORDER BY ${schema.repositories.fullName} ASC
  `);

  // Raw SQL results do not pass through Drizzle's timestamp column mappers,
  // so normalize the timestamptz aliases before the pure derivation layer.
  return (result.rows as unknown as RawRepoHealthRow[]).map((row) => ({
    ...row,
    lastEnabledAt: toDate(row.lastEnabledAt),
    lastCompletedAt: row.lastCompletedAt === null ? null : toDate(row.lastCompletedAt),
    latestAttemptAt: row.latestAttemptAt === null ? null : toDate(row.latestAttemptAt),
  }));
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Derive the display state without any I/O so boundary behavior stays testable. */
export function deriveRepoHealth(row: RepoHealthRow, now: Date): RepoHealth {
  if (row.installationSuspended || row.completedCount > 0) return "healthy";

  if (row.attemptCount === 0) {
    return now.getTime() - row.lastEnabledAt.getTime() > NEVER_REVIEWED_AFTER_MS
      ? "never-reviewed"
      : "awaiting-first-pr";
  }

  if (row.latestAttemptStatus === "failed" || row.latestAttemptStatus === "stale") {
    return "failing";
  }

  if (
    (row.latestAttemptStatus === "queued" || row.latestAttemptStatus === "running") &&
    row.latestAttemptAt !== null &&
    now.getTime() - row.latestAttemptAt.getTime() > PENDING_REVIEW_STALE_AFTER_MS
  ) {
    return "failing";
  }

  return "healthy";
}
