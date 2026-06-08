import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ReviewEnvelope, ReviewFinding } from "@/jobs/review-types";

export type ReviewFailureClass =
  | "queue"
  | "trigger"
  | "auth"
  | "config"
  | "cli"
  | "model"
  | "github_api"
  | "parser"
  | "timeout";

export type ReviewTriggerPath =
  | "hosted_pull_request"
  | "hosted_mention"
  | "github_action"
  | "cli";

export function classifyReviewFailure(err: unknown): ReviewFailureClass {
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    if (record.timedOut === true || record.signal === "SIGTERM") return "timeout";
    if (record.code === "CLI_NOT_FOUND") return "config";
    const status = typeof record.status === "number" ? record.status : undefined;
    if (status === 401 || status === 403) return "auth";
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/trigger/i.test(message)) return "trigger";
  if (/token|auth|credential|permission/i.test(message)) return "auth";
  if (/config|secret|project id|cli path/i.test(message)) return "config";
  if (/parse|json|schema|envelope/i.test(message)) return "parser";
  if (/model|openrouter|provider/i.test(message)) return "model";
  if (/github|check.?run|octokit|api/i.test(message)) return "github_api";
  if (/queue|enqueue|dispatch/i.test(message)) return "queue";
  return "cli";
}

export function findingCounts(findings: ReviewFinding[]) {
  return findings.reduce(
    (counts, finding) => {
      counts.findingCount += 1;
      if (finding.severity === "error") counts.errorFindingCount += 1;
      else if (finding.severity === "warn") counts.warnFindingCount += 1;
      else counts.infoFindingCount += 1;
      return counts;
    },
    {
      findingCount: 0,
      errorFindingCount: 0,
      warnFindingCount: 0,
      infoFindingCount: 0,
    },
  );
}

function modelProvider(model: string | null | undefined): string | null {
  if (!model) return null;
  const [provider] = model.split("/");
  return provider || null;
}

export async function recordReviewMetric(input: {
  reviewId?: string;
  installationId?: number;
  repoFullName: string;
  pullNumber?: number | null;
  headSha?: string | null;
  checkRunId?: number | null;
  triggerRunId?: string | null;
  workflowRunId?: number | null;
  triggerPath: ReviewTriggerPath;
  status: "queued" | "running" | "completed" | "failed";
  conclusion?: "success" | "neutral" | "failure" | "cancelled" | null;
  failureClass?: ReviewFailureClass | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  latencyMs?: number | null;
  timeoutMs?: number | null;
  modelUsed?: string | null;
  modelCascade?: string | null;
  result?: ReviewEnvelope | null;
  inlineCommentCount?: number;
  postedCommentCount?: number;
  suppressedCleanComment?: boolean;
  rerun?: boolean;
  replay?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const review = input.reviewId
    ? await db.query.reviews.findFirst({
        where: eq(schema.reviews.id, input.reviewId),
        columns: { organizationId: true },
      })
    : null;
  const resultCounts = findingCounts(input.result?.findings ?? []);
  const usage = input.result?.usage;
  const modelUsed = input.result?.modelUsed ?? input.modelUsed ?? null;

  await db
    .insert(schema.reviewMetrics)
    .values({
      reviewId: input.reviewId,
      organizationId: review?.organizationId ?? null,
      installationId: input.installationId ?? null,
      repoFullName: input.repoFullName,
      pullNumber: input.pullNumber ?? null,
      headSha: input.headSha ?? null,
      checkRunId: input.checkRunId ?? null,
      triggerRunId: input.triggerRunId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      triggerPath: input.triggerPath,
      status: input.status,
      conclusion: input.conclusion ?? null,
      failureClass: input.failureClass ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      latencyMs: input.latencyMs ?? null,
      timeoutMs: input.timeoutMs ?? null,
      modelProvider: modelProvider(modelUsed) ?? null,
      modelUsed,
      modelCascade: input.modelCascade ?? null,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      fallbackUsed: Boolean(input.modelCascade && modelUsed && input.modelCascade.split(",")[0]?.trim() !== modelUsed),
      findingCategoryCounts: {},
      ...resultCounts,
      inlineCommentCount: input.inlineCommentCount ?? 0,
      postedCommentCount: input.postedCommentCount ?? 0,
      suppressedCleanComment: input.suppressedCleanComment ?? false,
      reviewBodyLength: input.result?.summary.length ?? 0,
      reviewCommentLength: input.result?.summary.length ?? 0,
      rerun: input.rerun ?? false,
      replay: input.replay ?? false,
      metadata: input.metadata ?? {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.reviewMetrics.reviewId,
      set: {
        status: input.status,
        conclusion: input.conclusion ?? null,
        failureClass: input.failureClass ?? null,
        completedAt: input.completedAt ?? null,
        latencyMs: input.latencyMs ?? null,
        modelProvider: modelProvider(modelUsed) ?? null,
        modelUsed,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        ...resultCounts,
        inlineCommentCount: input.inlineCommentCount ?? 0,
        postedCommentCount: input.postedCommentCount ?? 0,
        suppressedCleanComment: input.suppressedCleanComment ?? false,
        reviewBodyLength: input.result?.summary.length ?? 0,
        reviewCommentLength: input.result?.summary.length ?? 0,
        metadata: input.metadata ?? {},
        updatedAt: new Date(),
      },
    });
}
