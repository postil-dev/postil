import Link from "next/link";

import type { PrivateRepositoryAccessDecision } from "@/lib/private-repository-entitlement";

export function PrivateBillingNotice({
  orgSlug,
  decision,
}: {
  orgSlug: string;
  decision: PrivateRepositoryAccessDecision | null;
}) {
  if (!decision) return null;
  const nearingCap =
    decision.allowed &&
    decision.usageLimitMicros !== null &&
    decision.usageLimitMicros > 0 &&
    decision.usageMicros / decision.usageLimitMicros >= 0.8;
  const inGrace = decision.allowed && decision.reason === "past_due_grace";
  if (decision.allowed && !nearingCap && !inGrace) return null;
  if (decision.allowed) {
    const detail = inGrace
      ? "Payment is past due. Private processing continues during the configured grace period."
      : "Hosted inference has used at least 80% of its allowance and hard cap.";
    return (
      <div className="card mt-6 border-rust p-5" role="status">
        <p className="text-sm font-medium text-rust">
          {inGrace ? "Billing needs attention" : "Hosted usage is nearing its cap"}
        </p>
        <p className="mt-1 text-sm text-ink-soft">{detail}</p>
        <Link
          href={`/orgs/${encodeURIComponent(orgSlug)}/billing`}
          className="mt-3 inline-block text-xs font-medium text-rust hover:underline"
        >
          View billing status
        </Link>
      </div>
    );
  }
  const detail =
    decision.reason === "provider_mode_mismatch"
      ? "The configured inference mode does not match the organization’s billed plan."
      : decision.reason === "usage_cap_reached"
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
