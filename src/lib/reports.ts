import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";

const MAX_REPORT_LIMIT = 100;

export interface ReviewReportSummary {
  id: string;
  organizationSlug: string | null;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  status: string;
  checkRunId: number | null;
  triggerRunId: string | null;
  findingCount: number;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ReviewReportDetail extends ReviewReportSummary {
  result: unknown;
}

export interface ReviewReportListOptions {
  limit?: number;
  orgSlug?: string;
  q?: string;
}

type ReviewReportRow = {
  id: string;
  organizationSlug: string | null;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  status: string;
  checkRunId: number | null;
  triggerRunId: string | null;
  result: unknown;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export function reviewFindingCount(result: unknown): number {
  if (!result || typeof result !== "object" || !("findings" in result)) {
    return 0;
  }

  const findings = (result as { findings?: unknown }).findings;
  return Array.isArray(findings) ? findings.length : 0;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_REPORT_LIMIT);
}

function toSummary(row: ReviewReportRow): ReviewReportSummary {
  return {
    id: row.id,
    organizationSlug: row.organizationSlug,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    headSha: row.headSha,
    status: row.status,
    checkRunId: row.checkRunId,
    triggerRunId: row.triggerRunId,
    findingCount: reviewFindingCount(row.result),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function reportProjection() {
  return {
    id: schema.reviews.id,
    organizationSlug: schema.organizations.slug,
    repoFullName: schema.reviews.repoFullName,
    pullNumber: schema.reviews.pullNumber,
    headSha: schema.reviews.headSha,
    status: schema.reviews.status,
    checkRunId: schema.reviews.checkRunId,
    triggerRunId: schema.reviews.triggerRunId,
    result: schema.reviews.result,
    errorMessage: schema.reviews.errorMessage,
    createdAt: schema.reviews.createdAt,
    completedAt: schema.reviews.completedAt,
  };
}

function reportFilters(options: ReviewReportListOptions): SQL | undefined {
  const filters: SQL[] = [];
  const orgSlug = options.orgSlug?.trim();
  const q = options.q?.trim();

  if (orgSlug) {
    filters.push(eq(schema.organizations.slug, orgSlug));
  }

  if (q) {
    const pattern = `%${q}%`;
    filters.push(
      or(
        ilike(schema.reviews.repoFullName, pattern),
        ilike(schema.reviews.headSha, pattern),
        ilike(schema.reviews.status, pattern),
      ) as SQL,
    );
  }

  return filters.length > 0 ? and(...filters) : undefined;
}

export async function listReviewReports(
  options: ReviewReportListOptions = {},
): Promise<ReviewReportSummary[]> {
  const db = getDb();
  const filters = reportFilters(options);
  const query = db
    .select(reportProjection())
    .from(schema.reviews)
    .leftJoin(schema.organizations, eq(schema.reviews.organizationId, schema.organizations.id));
  const rows = filters
    ? await query
        .where(filters)
        .orderBy(desc(schema.reviews.createdAt))
        .limit(clampLimit(options.limit))
    : await query.orderBy(desc(schema.reviews.createdAt)).limit(clampLimit(options.limit));

  return rows.map(toSummary);
}

export async function getReviewReport(id: string): Promise<ReviewReportDetail | null> {
  const db = getDb();
  const rows = await db
    .select(reportProjection())
    .from(schema.reviews)
    .leftJoin(schema.organizations, eq(schema.reviews.organizationId, schema.organizations.id))
    .where(eq(schema.reviews.id, id))
    .limit(1);

  const row = rows[0];
  return row ? { ...toSummary(row), result: row.result } : null;
}
