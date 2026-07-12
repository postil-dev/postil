import Link from "next/link";

import type { PrivateRepositoryAccessDecision } from "@/lib/private-repository-entitlement";

export function PrivateBillingNotice({
  orgSlug,
  decision,
}: {
  orgSlug: string;
  decision: PrivateRepositoryAccessDecision | null;
}) {
  if (!decision || decision.allowed) return null;
  const detail =
    decision.reason === "usage_cap_reached"
      ? "The organization usage cap has been reached."
      : decision.reason === "suspended"
        ? "The organization entitlement is suspended."
        : "No active subscription, trial, grace period, or promotion is recorded.";
  return (
    <div className="card mt-6 border-rust p-5" role="status">
      <p className="text-sm font-medium text-rust">Private repositories are paused</p>
      <p className="mt-1 text-sm text-ink-soft">
        {detail} Billing is required before Postil runs reviews or responds in private
        repositories. Public repositories are unaffected.
      </p>
      <Link
        href={`/orgs/${encodeURIComponent(orgSlug)}/billing`}
        className="mt-3 inline-block text-xs font-medium text-rust hover:underline"
      >
        View billing status
      </Link>
    </div>
  );
}
