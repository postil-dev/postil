import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ReviewTriggerPath } from "@/lib/review-metrics";
import type { ReportViewer } from "@/lib/reports";

export type DashboardReviewStatus = "active" | "failing" | "quiet";

export interface DashboardOrganization {
  id: string;
  slug: string;
  name: string;
  githubLogin: string | null;
  plan: string;
}

export interface DashboardInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspended: boolean;
  updatedAt: Date;
}

export interface DashboardRepository {
  repoFullName: string;
  status: DashboardReviewStatus;
  lastReviewedAt: Date | null;
  lastTriggerPath: ReviewTriggerPath | null;
  reviewCount: number;
  findingCount: number;
  suppressedCleanCount: number;
  failureCount: number;
  configHealth: "connected" | "attention" | "waiting";
}

export interface DashboardReview {
  id: string;
  reviewId: string | null;
  repoFullName: string;
  pullNumber: number | null;
  headSha: string | null;
  triggerPath: ReviewTriggerPath;
  status: string;
  conclusion: string | null;
  failureClass: string | null;
  latencyMs: number | null;
  findingCount: number;
  errorFindingCount: number;
  warnFindingCount: number;
  infoFindingCount: number;
  suppressedCleanComment: boolean;
  checkRunId: number | null;
  workflowRunId: number | null;
  createdAt: Date;
}

export interface CustomerDashboard {
  organization: DashboardOrganization | null;
  installations: DashboardInstallation[];
  repositories: DashboardRepository[];
  reviews: DashboardReview[];
  totals: {
    reviews: number;
    repositories: number;
    findings: number;
    suppressedCleanComments: number;
    failures: number;
  };
}

type MetricRow = {
  id: string;
  reviewId: string | null;
  repoFullName: string;
  pullNumber: number | null;
  headSha: string | null;
  triggerPath: string;
  status: string;
  conclusion: string | null;
  failureClass: string | null;
  latencyMs: number | null;
  findingCount: number;
  errorFindingCount: number;
  warnFindingCount: number;
  infoFindingCount: number;
  suppressedCleanComment: boolean;
  checkRunId: number | null;
  workflowRunId: number | null;
  createdAt: Date;
};

const triggerPaths = new Set<ReviewTriggerPath>([
  "hosted_pull_request",
  "hosted_mention",
  "github_action",
  "cli",
]);

function toTriggerPath(value: string): ReviewTriggerPath {
  return triggerPaths.has(value as ReviewTriggerPath)
    ? (value as ReviewTriggerPath)
    : "hosted_pull_request";
}

function metricFailed(metric: Pick<MetricRow, "status" | "conclusion" | "failureClass">): boolean {
  return (
    metric.status === "failed" || metric.conclusion === "failure" || Boolean(metric.failureClass)
  );
}

export function summarizeDashboard(input: {
  organization: DashboardOrganization | null;
  installations: DashboardInstallation[];
  metrics: MetricRow[];
}): CustomerDashboard {
  const repos = new Map<string, DashboardRepository>();
  let findings = 0;
  let suppressedCleanComments = 0;
  let failures = 0;

  for (const metric of input.metrics) {
    const failed = metricFailed(metric);
    findings += metric.findingCount;
    if (metric.suppressedCleanComment) suppressedCleanComments += 1;
    if (failed) failures += 1;

    const existing = repos.get(metric.repoFullName);
    const lastReviewedAt =
      !existing?.lastReviewedAt || metric.createdAt > existing.lastReviewedAt
        ? metric.createdAt
        : existing.lastReviewedAt;
    const status: DashboardReviewStatus = failed
      ? "failing"
      : existing?.status === "failing"
        ? "failing"
        : metric.status === "completed"
          ? "active"
          : "quiet";

    repos.set(metric.repoFullName, {
      repoFullName: metric.repoFullName,
      status,
      lastReviewedAt,
      lastTriggerPath:
        !existing?.lastReviewedAt || metric.createdAt >= existing.lastReviewedAt
          ? toTriggerPath(metric.triggerPath)
          : existing.lastTriggerPath,
      reviewCount: (existing?.reviewCount ?? 0) + 1,
      findingCount: (existing?.findingCount ?? 0) + metric.findingCount,
      suppressedCleanCount:
        (existing?.suppressedCleanCount ?? 0) + (metric.suppressedCleanComment ? 1 : 0),
      failureCount: (existing?.failureCount ?? 0) + (failed ? 1 : 0),
      configHealth: failed ? "attention" : "connected",
    });
  }

  const repositories = Array.from(repos.values()).sort((a, b) => {
    const aTime = a.lastReviewedAt?.getTime() ?? 0;
    const bTime = b.lastReviewedAt?.getTime() ?? 0;
    return bTime - aTime || a.repoFullName.localeCompare(b.repoFullName);
  });

  const reviews = input.metrics.map((metric) => ({
    ...metric,
    triggerPath: toTriggerPath(metric.triggerPath),
  }));

  return {
    organization: input.organization,
    installations: input.installations,
    repositories,
    reviews,
    totals: {
      reviews: input.metrics.length,
      repositories: repositories.length,
      findings,
      suppressedCleanComments,
      failures,
    },
  };
}

export async function getCustomerDashboard(
  viewer: ReportViewer | null,
): Promise<CustomerDashboard> {
  if (!viewer?.organizationId) {
    return summarizeDashboard({ organization: null, installations: [], metrics: [] });
  }

  const db = getDb();
  const [organization] = await db
    .select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      name: schema.organizations.name,
      githubLogin: schema.organizations.githubLogin,
      plan: schema.organizations.plan,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, viewer.organizationId))
    .limit(1);

  if (!organization) {
    return summarizeDashboard({ organization: null, installations: [], metrics: [] });
  }

  const [installations, metrics] = await Promise.all([
    db
      .select({
        id: schema.installations.id,
        accountLogin: schema.installations.accountLogin,
        accountType: schema.installations.accountType,
        repositorySelection: schema.installations.repositorySelection,
        suspended: schema.installations.suspended,
        updatedAt: schema.installations.updatedAt,
      })
      .from(schema.installations)
      .where(eq(schema.installations.organizationId, viewer.organizationId))
      .orderBy(desc(schema.installations.updatedAt)),
    db
      .select({
        id: schema.reviewMetrics.id,
        reviewId: schema.reviewMetrics.reviewId,
        repoFullName: schema.reviewMetrics.repoFullName,
        pullNumber: schema.reviewMetrics.pullNumber,
        headSha: schema.reviewMetrics.headSha,
        triggerPath: schema.reviewMetrics.triggerPath,
        status: schema.reviewMetrics.status,
        conclusion: schema.reviewMetrics.conclusion,
        failureClass: schema.reviewMetrics.failureClass,
        latencyMs: schema.reviewMetrics.latencyMs,
        findingCount: schema.reviewMetrics.findingCount,
        errorFindingCount: schema.reviewMetrics.errorFindingCount,
        warnFindingCount: schema.reviewMetrics.warnFindingCount,
        infoFindingCount: schema.reviewMetrics.infoFindingCount,
        suppressedCleanComment: schema.reviewMetrics.suppressedCleanComment,
        checkRunId: schema.reviewMetrics.checkRunId,
        workflowRunId: schema.reviewMetrics.workflowRunId,
        createdAt: schema.reviewMetrics.createdAt,
      })
      .from(schema.reviewMetrics)
      .where(eq(schema.reviewMetrics.organizationId, viewer.organizationId))
      .orderBy(desc(schema.reviewMetrics.createdAt))
      .limit(100),
  ]);

  return summarizeDashboard({ organization, installations, metrics });
}
