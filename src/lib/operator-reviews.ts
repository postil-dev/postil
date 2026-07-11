import { and, desc, eq, gte, ilike, lt, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import type { Envelope } from "@/lib/envelope";
import type { OrgReviewStatus } from "@/lib/org-reviews";

export type OperatorReviewStatus = OrgReviewStatus;

export interface OperatorReviewFilters {
  org: string;
  repo: string;
  status: "" | OperatorReviewStatus;
  from: string;
  to: string;
}

export interface OperatorReviewRow {
  id: number;
  publicId: string;
  prNumber: number;
  status: OperatorReviewStatus;
  silent: boolean | null;
  gateFailing: boolean | null;
  envelope: Envelope | null;
  errorMessage: string | null;
  headSha: string;
  advisoryCheckRunId: number | null;
  gateCheckRunId: number | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  repoFullName: string;
  orgSlug: string;
  orgName: string;
  totalRows: number;
}

const STATUSES: OperatorReviewStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "stale",
];

export const OPERATOR_REVIEW_LIMIT = 100;

export function parseOperatorReviewFilters(
  searchParams: Record<string, string | string[] | undefined>,
): OperatorReviewFilters {
  const status = first(searchParams.status);
  return {
    org: first(searchParams.org).trim(),
    repo: first(searchParams.repo).trim(),
    status: STATUSES.includes(status as OperatorReviewStatus)
      ? (status as OperatorReviewStatus)
      : "",
    from: normalizeDate(first(searchParams.from)),
    to: normalizeDate(first(searchParams.to)),
  };
}

export async function getOperatorReviewRows(
  db: Database,
  filters: OperatorReviewFilters,
  limit = OPERATOR_REVIEW_LIMIT,
): Promise<OperatorReviewRow[]> {
  const predicates = [
    filters.org
      ? ilike(schema.organizations.slug, `%${escapeLike(filters.org)}%`)
      : undefined,
    filters.repo
      ? ilike(schema.repositories.fullName, `%${escapeLike(filters.repo)}%`)
      : undefined,
    filters.status ? eq(schema.reviews.status, filters.status) : undefined,
    filters.from ? gte(schema.reviews.queuedAt, startOfUtcDay(filters.from)) : undefined,
    filters.to ? lt(schema.reviews.queuedAt, dayAfterUtc(filters.to)) : undefined,
  ].filter(Boolean);

  const where = predicates.length > 0 ? and(...predicates) : undefined;

  return db
    .select({
      id: schema.reviews.id,
      publicId: schema.reviews.publicId,
      prNumber: schema.reviews.prNumber,
      status: schema.reviews.status,
      silent: schema.reviews.silent,
      gateFailing: schema.reviews.gateFailing,
      envelope: schema.reviews.envelope,
      errorMessage: schema.reviews.errorMessage,
      headSha: schema.reviews.headSha,
      advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
      gateCheckRunId: schema.reviews.gateCheckRunId,
      queuedAt: schema.reviews.queuedAt,
      startedAt: schema.reviews.startedAt,
      finishedAt: schema.reviews.finishedAt,
      repoFullName: schema.repositories.fullName,
      orgSlug: schema.organizations.slug,
      orgName: schema.organizations.name,
      totalRows: sql<number>`count(*) over()::int`,
    })
    .from(schema.reviews)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.installations.orgId))
    .where(where)
    .orderBy(desc(schema.reviews.queuedAt), desc(schema.reviews.id))
    .limit(limit);
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function normalizeDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function startOfUtcDay(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dayAfterUtc(value: string): Date {
  const date = startOfUtcDay(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
