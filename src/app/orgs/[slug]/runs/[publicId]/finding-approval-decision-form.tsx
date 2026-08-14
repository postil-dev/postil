import type { FindingApprovalState } from "@/lib/finding-approvals";

import { approveFinding } from "../../actions";

export function FindingApprovalDecisionForm({
  slug,
  publicId,
  state,
  approvable,
  isAdmin,
  viewerGithubId,
}: {
  slug: string;
  publicId: string;
  state: FindingApprovalState;
  approvable: boolean;
  isAdmin: boolean;
  viewerGithubId: string;
}) {
  const canAcknowledgeAuthorDismissal =
    !state.awaitingIndependentAck ||
    state.activeDismissal?.actorGithubId !== viewerGithubId;
  const visible =
    isAdmin &&
    approvable &&
    !state.activeApproval &&
    canAcknowledgeAuthorDismissal &&
    (state.awaitingIndependentAck ||
      (!state.activeDismissal &&
        !state.latestApproval?.revokedAt &&
        !state.severityBlocking));
  if (!visible) return null;

  return (
    <details
      name={`finding-decision-${state.findingId}`}
      className="mt-4 rounded-card border border-stone/70 px-3 py-2 text-sm"
    >
      <summary className="cursor-pointer font-medium text-charcoal/75">
        {state.awaitingIndependentAck
          ? "Acknowledge the author's dismissal"
          : "Record a commit-scoped override"}
      </summary>
      <form action={approveFinding} className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="publicId" value={publicId} />
        <input type="hidden" name="findingId" value={state.findingId} />
        <label className="grid gap-1 text-xs font-medium text-charcoal/75">
          Rationale
          <textarea
            name="rationale"
            required
            minLength={1}
            rows={2}
            className="min-h-16 rounded-md border border-stone bg-ivory px-3 py-2 text-sm text-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rust"
            placeholder={state.awaitingIndependentAck
              ? "Why this dismissal is acceptable"
              : "Why no code or configuration change can resolve this decision"}
          />
        </label>
        <button className="rounded-md bg-charcoal px-4 py-2 text-sm font-semibold text-ivory hover:bg-rust">
          {state.awaitingIndependentAck ? "Acknowledge dismissal" : "Record override"}
        </button>
      </form>
    </details>
  );
}
