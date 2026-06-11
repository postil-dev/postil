import { and, desc, eq, gte, ilike, or, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ReviewTriggerPath } from "@/lib/review-metrics";

const ADMIN_REVIEW_LIMIT = 200;
const SECRET_KEY_PATTERN =
  /(api[_-]?key|authorization|cookie|password|private[_-]?key|secret|token)/i;

export interface AdminDashboardFilters {
  q?: string;
  install?: string;
  repo?: string;
  status?: string;
  failureClass?: string;
  triggerPath?: string;
  model?: string;
  since?: "24h" | "7d" | "30d";
}

export interface AdminReviewSummary {
  id: string;
  reviewId: string | null;
  organizationId: string | null;
  installationId: number | null;
  repoFullName: string;
  pullNumber: number | null;
  headSha: string | null;
  checkRunId: number | null;
  triggerRunId: string | null;
  workflowRunId: number | null;
  triggerPath: ReviewTriggerPath;
  status: string;
  conclusion: string | null;
  failureClass: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  latencyMs: number | null;
  timeoutMs: number | null;
  modelProvider: string | null;
  modelUsed: string | null;
  modelCascade: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  fallbackUsed: boolean;
  cliVersion: string | null;
  actionVersion: string | null;
  hostedAppVersion: string | null;
  findingCount: number;
  errorFindingCount: number;
  warnFindingCount: number;
  infoFindingCount: number;
  inlineCommentCount: number;
  postedCommentCount: number;
  suppressedCleanComment: boolean;
  rerun: boolean;
  replay: boolean;
  metadataPreview: Record<string, unknown>;
  createdAt: Date;
}

export interface AdminFailureGroup {
  failureClass: string;
  count: number;
  latestAt: Date;
  nextAction: string;
}

export interface AdminDashboard {
  reviews: AdminReviewSummary[];
  failures: AdminFailureGroup[];
  totals: {
    installs: number;
    repositories: number;
    reviews: number;
    failures: number;
    findings: number;
    suppressedCleanComments: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    averageLatencyMs: number | null;
  };
}

type AdminMetricRow = Omit<AdminReviewSummary, "triggerPath" | "metadataPreview"> & {
  triggerPath: string;
  metadata: Record<string, unknown>;
};

const triggerPaths = new Set<ReviewTriggerPath>([
  "hosted_pull_request",
  "hosted_mention",
  "github_action",
  "cli",
]);

const failureActions: Record<string, string> = {
  app_auth: "Check installation auth and webhook delivery state.",
  config: "Inspect repository config and installation selection.",
  github_api: "Review GitHub API status, rate limits, and linked check run.",
  model: "Inspect provider/model response details and fallback usage.",
  sandbox: "Check execution logs and timeout settings.",
  timeout: "Compare run latency with timeout budget and retry window.",
};

export function toAdminTriggerPath(value: string): ReviewTriggerPath {
  return triggerPaths.has(value as ReviewTriggerPath)
    ? (value as ReviewTriggerPath)
    : "hosted_pull_request";
}

export function sanitizeMetadata(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return {};

  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = "[redacted]";
      continue;
    }

    if (raw === null || ["boolean", "number"].includes(typeof raw)) {
      output[key] = raw;
    } else if (typeof raw === "string") {
      output[key] = raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
    } else if (Array.isArray(raw)) {
      output[key] = `[${raw.length} items]`;
    } else if (typeof raw === "object") {
      output[key] = sanitizeMetadata(raw, depth + 1);
    }
  }

  return output;
}

function failureNextAction(failureClass: string): string {
  return (
    failureActions[failureClass] ??
    "Open the review detail and inspect status, links, and sanitized metadata."
  );
}

function sinceDate(value: AdminDashboardFilters["since"]): Date | null {
  const now = Date.now();
  if (value === "24h") return new Date(now - 24 * 60 * 60 * 1000);
  if (value === "7d") return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (value === "30d") return new Date(now - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function adminFilters(filters: AdminDashboardFilters): SQL | undefined {
  const clauses: SQL[] = [];
  const q = filters.q?.trim();
  const install = filters.install?.trim();
  const repo = filters.repo?.trim();
  const status = filters.status?.trim();
  const failureClass = filters.failureClass?.trim();
  const triggerPath = filters.triggerPath?.trim();
  const model = filters.model?.trim();
  const since = sinceDate(filters.since);

  if (q) {
    const pattern = `%${q}%`;
    clauses.push(
      or(
        ilike(schema.reviewMetrics.repoFullName, pattern),
        ilike(schema.reviewMetrics.headSha, pattern),
        ilike(schema.reviewMetrics.status, pattern),
        ilike(schema.reviewMetrics.failureClass, pattern),
        ilike(schema.reviewMetrics.modelUsed, pattern),
      ) as SQL,
    );
  }
  if (install && Number.isFinite(Number(install))) {
    clauses.push(eq(schema.reviewMetrics.installationId, Number(install)));
  }
  if (repo) clauses.push(ilike(schema.reviewMetrics.repoFullName, `%${repo}%`));
  if (status) clauses.push(eq(schema.reviewMetrics.status, status));
  if (failureClass) clauses.push(eq(schema.reviewMetrics.failureClass, failureClass));
  if (triggerPath) clauses.push(eq(schema.reviewMetrics.triggerPath, triggerPath));
  if (model) clauses.push(ilike(schema.reviewMetrics.modelUsed, `%${model}%`));
  if (since) clauses.push(gte(schema.reviewMetrics.createdAt, since));

  return clauses.length > 0 ? and(...clauses) : undefined;
}

function projectRow(row: AdminMetricRow): AdminReviewSummary {
  return {
    ...row,
    triggerPath: toAdminTriggerPath(row.triggerPath),
    metadataPreview: sanitizeMetadata(row.metadata),
  };
}

export function summarizeAdminDashboard(rows: AdminMetricRow[]): AdminDashboard {
  const installs = new Set<number>();
  const repositories = new Set<string>();
  const failureGroups = new Map<string, AdminFailureGroup>();
  let failures = 0;
  let findings = 0;
  let suppressedCleanComments = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let latencyTotal = 0;
  let latencyCount = 0;

  const reviews = rows.map((row) => {
    if (row.installationId !== null) installs.add(row.installationId);
    repositories.add(row.repoFullName);
    findings += row.findingCount;
    promptTokens += row.promptTokens;
    completionTokens += row.completionTokens;
    totalTokens += row.totalTokens;
    if (row.suppressedCleanComment) suppressedCleanComments += 1;
    if (row.latencyMs !== null) {
      latencyTotal += row.latencyMs;
      latencyCount += 1;
    }
    if (row.failureClass || row.status === "failed" || row.conclusion === "failure") {
      failures += 1;
      const key = row.failureClass ?? "unclassified";
      const existing = failureGroups.get(key);
      if (!existing || row.createdAt > existing.latestAt) {
        failureGroups.set(key, {
          failureClass: key,
          count: (existing?.count ?? 0) + 1,
          latestAt: row.createdAt,
          nextAction: failureNextAction(key),
        });
      } else if (existing) {
        existing.count += 1;
      }
    }
    return projectRow(row);
  });

  return {
    reviews,
    failures: Array.from(failureGroups.values()).sort(
      (a, b) => b.count - a.count || b.latestAt.getTime() - a.latestAt.getTime(),
    ),
    totals: {
      installs: installs.size,
      repositories: repositories.size,
      reviews: rows.length,
      failures,
      findings,
      suppressedCleanComments,
      promptTokens,
      completionTokens,
      totalTokens,
      averageLatencyMs: latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : null,
    },
  };
}

export async function getAdminDashboard(filters: AdminDashboardFilters): Promise<AdminDashboard> {
  const db = getDb();
  const where = adminFilters(filters);
  const query = db
    .select({
      id: schema.reviewMetrics.id,
      reviewId: schema.reviewMetrics.reviewId,
      organizationId: schema.reviewMetrics.organizationId,
      installationId: schema.reviewMetrics.installationId,
      repoFullName: schema.reviewMetrics.repoFullName,
      pullNumber: schema.reviewMetrics.pullNumber,
      headSha: schema.reviewMetrics.headSha,
      checkRunId: schema.reviewMetrics.checkRunId,
      triggerRunId: schema.reviewMetrics.triggerRunId,
      workflowRunId: schema.reviewMetrics.workflowRunId,
      triggerPath: schema.reviewMetrics.triggerPath,
      status: schema.reviewMetrics.status,
      conclusion: schema.reviewMetrics.conclusion,
      failureClass: schema.reviewMetrics.failureClass,
      startedAt: schema.reviewMetrics.startedAt,
      completedAt: schema.reviewMetrics.completedAt,
      latencyMs: schema.reviewMetrics.latencyMs,
      timeoutMs: schema.reviewMetrics.timeoutMs,
      modelProvider: schema.reviewMetrics.modelProvider,
      modelUsed: schema.reviewMetrics.modelUsed,
      modelCascade: schema.reviewMetrics.modelCascade,
      promptTokens: schema.reviewMetrics.promptTokens,
      completionTokens: schema.reviewMetrics.completionTokens,
      totalTokens: schema.reviewMetrics.totalTokens,
      fallbackUsed: schema.reviewMetrics.fallbackUsed,
      cliVersion: schema.reviewMetrics.cliVersion,
      actionVersion: schema.reviewMetrics.actionVersion,
      hostedAppVersion: schema.reviewMetrics.hostedAppVersion,
      findingCount: schema.reviewMetrics.findingCount,
      errorFindingCount: schema.reviewMetrics.errorFindingCount,
      warnFindingCount: schema.reviewMetrics.warnFindingCount,
      infoFindingCount: schema.reviewMetrics.infoFindingCount,
      inlineCommentCount: schema.reviewMetrics.inlineCommentCount,
      postedCommentCount: schema.reviewMetrics.postedCommentCount,
      suppressedCleanComment: schema.reviewMetrics.suppressedCleanComment,
      rerun: schema.reviewMetrics.rerun,
      replay: schema.reviewMetrics.replay,
      metadata: schema.reviewMetrics.metadata,
      createdAt: schema.reviewMetrics.createdAt,
    })
    .from(schema.reviewMetrics);

  const rows = where
    ? await query
        .where(where)
        .orderBy(desc(schema.reviewMetrics.createdAt))
        .limit(ADMIN_REVIEW_LIMIT)
    : await query.orderBy(desc(schema.reviewMetrics.createdAt)).limit(ADMIN_REVIEW_LIMIT);

  return summarizeAdminDashboard(rows);
}

export async function getAdminReviewDetail(id: string): Promise<AdminReviewSummary | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.reviewMetrics.id,
      reviewId: schema.reviewMetrics.reviewId,
      organizationId: schema.reviewMetrics.organizationId,
      installationId: schema.reviewMetrics.installationId,
      repoFullName: schema.reviewMetrics.repoFullName,
      pullNumber: schema.reviewMetrics.pullNumber,
      headSha: schema.reviewMetrics.headSha,
      checkRunId: schema.reviewMetrics.checkRunId,
      triggerRunId: schema.reviewMetrics.triggerRunId,
      workflowRunId: schema.reviewMetrics.workflowRunId,
      triggerPath: schema.reviewMetrics.triggerPath,
      status: schema.reviewMetrics.status,
      conclusion: schema.reviewMetrics.conclusion,
      failureClass: schema.reviewMetrics.failureClass,
      startedAt: schema.reviewMetrics.startedAt,
      completedAt: schema.reviewMetrics.completedAt,
      latencyMs: schema.reviewMetrics.latencyMs,
      timeoutMs: schema.reviewMetrics.timeoutMs,
      modelProvider: schema.reviewMetrics.modelProvider,
      modelUsed: schema.reviewMetrics.modelUsed,
      modelCascade: schema.reviewMetrics.modelCascade,
      promptTokens: schema.reviewMetrics.promptTokens,
      completionTokens: schema.reviewMetrics.completionTokens,
      totalTokens: schema.reviewMetrics.totalTokens,
      fallbackUsed: schema.reviewMetrics.fallbackUsed,
      cliVersion: schema.reviewMetrics.cliVersion,
      actionVersion: schema.reviewMetrics.actionVersion,
      hostedAppVersion: schema.reviewMetrics.hostedAppVersion,
      findingCount: schema.reviewMetrics.findingCount,
      errorFindingCount: schema.reviewMetrics.errorFindingCount,
      warnFindingCount: schema.reviewMetrics.warnFindingCount,
      infoFindingCount: schema.reviewMetrics.infoFindingCount,
      inlineCommentCount: schema.reviewMetrics.inlineCommentCount,
      postedCommentCount: schema.reviewMetrics.postedCommentCount,
      suppressedCleanComment: schema.reviewMetrics.suppressedCleanComment,
      rerun: schema.reviewMetrics.rerun,
      replay: schema.reviewMetrics.replay,
      metadata: schema.reviewMetrics.metadata,
      createdAt: schema.reviewMetrics.createdAt,
    })
    .from(schema.reviewMetrics)
    .where(eq(schema.reviewMetrics.id, id))
    .limit(1);

  const row = rows[0];
  return row ? projectRow(row) : null;
}
