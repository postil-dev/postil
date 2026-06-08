export type ReviewFailureClass =
  | "configuration_error"
  | "dispatch_failure"
  | "github_api_failure"
  | "check_run_update_failure"
  | "workflow_mismatch"
  | "timeout"
  | "duplicate_completion"
  | "review_failure";

export function reviewFailureClass(status: string, errorMessage: string | null): ReviewFailureClass | null {
  if (status !== "failed") return null;

  const message = (errorMessage ?? "").toLowerCase();
  if (!message) return "review_failure";
  if (message.includes("timed out before completion")) return "timeout";
  if (message.includes("completed by another postil check")) return "duplicate_completion";
  if (message.includes("did not match a review check-run")) return "workflow_mismatch";
  if (message.includes("could not be enqueued") || message.includes("failed to initialize review row")) {
    return "dispatch_failure";
  }
  if (message.includes("check-run") && message.includes("patch failed")) {
    return "check_run_update_failure";
  }
  if (message.includes("watchdog auth is not configured") || message.includes("missing watchdog token")) {
    return "configuration_error";
  }
  if (message.includes("rate limit") || message.includes("secondary rate limit")) {
    return "github_api_failure";
  }
  return "review_failure";
}
