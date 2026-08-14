export const REVIEW_TRIGGER_SOURCES = [
  "unknown",
  "automatic_pull_request",
  "requested_review",
  "github_check_rerun",
  "finding_reconciliation",
] as const;

export type ReviewTriggerSource = (typeof REVIEW_TRIGGER_SOURCES)[number];

export interface ReviewTriggerContext {
  source: ReviewTriggerSource;
  webhookDeliveryId?: string;
  webhookEvent?: "pull_request" | "issue_comment" | "pull_request_review_comment" | "pull_request_review_thread" | "check_run" | "check_suite";
  webhookAction?: string;
  sourceCommentId?: number;
  sourceUrl?: string;
  requestedByGithubId?: number;
  requestedByLogin?: string;
  checkName?: string;
}

const TRIGGER_LABELS: Record<ReviewTriggerSource, string> = {
  unknown: "Unknown",
  automatic_pull_request: "Automatic",
  requested_review: "Requested",
  github_check_rerun: "Check rerun",
  finding_reconciliation: "Finding reconciliation",
};

export function reviewTriggerLabel(source: ReviewTriggerSource): string {
  return TRIGGER_LABELS[source];
}

export function reviewTriggerSearchTerms(source: ReviewTriggerSource): string {
  if (source === "automatic_pull_request") return "automatic pull request webhook";
  if (source === "requested_review") return "requested tagged mention command";
  if (source === "github_check_rerun") return "github check rerun rerequested";
  if (source === "finding_reconciliation") return "finding reconciliation webhook";
  return "unknown legacy";
}

export function reviewTriggerDescription(source: ReviewTriggerSource): string {
  if (source === "automatic_pull_request") return "Started by a pull request event";
  if (source === "requested_review") return "Requested in a GitHub comment";
  if (source === "github_check_rerun") return "Started by rerunning a GitHub check";
  if (source === "finding_reconciliation") return "Started by finding evidence or thread state";
  return "Origin not recorded";
}

/** Select a complete base-to-head diff for explicit reruns or a changed PR base. */
export function reviewRequiresFullDiff(input: {
  requested: boolean;
  baselineBaseSha?: string;
  currentBaseSha: string;
}): boolean {
  return input.requested ||
    (input.baselineBaseSha !== undefined && input.baselineBaseSha !== input.currentBaseSha);
}

export function normalizeReviewTriggerContext(value: unknown): ReviewTriggerContext {
  if (typeof value !== "object" || value === null) return { source: "unknown" };
  const candidate = value as Partial<ReviewTriggerContext>;
  if (
    typeof candidate.source !== "string" ||
    !REVIEW_TRIGGER_SOURCES.includes(candidate.source as ReviewTriggerSource)
  ) {
    return { source: "unknown" };
  }
  if (candidate.source === "unknown") return { source: "unknown" };
  if (
    typeof candidate.webhookDeliveryId !== "string" ||
    candidate.webhookDeliveryId.trim().length === 0 ||
    candidate.webhookDeliveryId.length > 200
  ) {
    return { source: "unknown" };
  }

  const allowedEvents =
    candidate.source === "automatic_pull_request"
      ? ["pull_request"]
      : candidate.source === "requested_review"
        ? ["issue_comment", "pull_request_review_comment"]
        : candidate.source === "github_check_rerun"
          ? ["check_run", "check_suite"]
          : ["pull_request_review_comment", "pull_request_review_thread"];
  if (!candidate.webhookEvent || !allowedEvents.includes(candidate.webhookEvent)) {
    return { source: "unknown" };
  }

  const normalized: ReviewTriggerContext = {
    source: candidate.source,
    webhookDeliveryId: candidate.webhookDeliveryId,
    webhookEvent: candidate.webhookEvent,
    ...(typeof candidate.webhookAction === "string" && candidate.webhookAction.length <= 100
      ? { webhookAction: candidate.webhookAction }
      : {}),
    ...(Number.isSafeInteger(candidate.sourceCommentId) && candidate.sourceCommentId! > 0
      ? { sourceCommentId: candidate.sourceCommentId }
      : {}),
    ...(safeGithubUrl(candidate.sourceUrl) ? { sourceUrl: candidate.sourceUrl } : {}),
    ...(Number.isSafeInteger(candidate.requestedByGithubId) && candidate.requestedByGithubId! > 0
      ? { requestedByGithubId: candidate.requestedByGithubId }
      : {}),
    ...(typeof candidate.requestedByLogin === "string" && candidate.requestedByLogin.length <= 100
      ? { requestedByLogin: candidate.requestedByLogin }
      : {}),
    ...(typeof candidate.checkName === "string" && candidate.checkName.length <= 200
      ? { checkName: candidate.checkName }
      : {}),
  };
  return normalized;
}

function safeGithubUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === "https://github.com";
  } catch {
    return false;
  }
}
