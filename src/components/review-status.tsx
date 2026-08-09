import { StatusIcon, type StatusKind } from "./status-icon";

import type { ReviewDisplayStatus } from "@/lib/review-outcome";

const STATUS_ICON: Record<ReviewDisplayStatus, StatusKind | null> = {
  queued: null,
  running: null,
  completed: "pass",
  failed: "error",
  stale: null,
  unavailable: "info",
};

export function ReviewStatusBadge({
  status,
  gateFailing,
}: {
  status: ReviewDisplayStatus;
  gateFailing: boolean | null;
}) {
  const icon = status === "completed" && gateFailing ? "warn" : STATUS_ICON[status];
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      {icon && <StatusIcon kind={icon} size={14} />}
      <span
        className={
          status === "failed"
            ? "text-softred"
            : status === "stale" || status === "unavailable"
              ? "text-charcoal/70"
              : "text-charcoal/80"
        }
      >
        {status}
      </span>
    </span>
  );
}

export function GateBadge({
  gateFailing,
  status,
  syncing = false,
  syncFailed = false,
}: {
  gateFailing: boolean | null;
  status: ReviewDisplayStatus;
  syncing?: boolean;
  syncFailed?: boolean;
}) {
  if (syncFailed) {
    return <span className="font-mono text-xs text-rust">gate sync failed</span>;
  }
  if (syncing) {
    return <span className="font-mono text-xs text-charcoal/70">syncing gate</span>;
  }
  if (status !== "completed" || gateFailing === null) {
    return <span className="font-mono text-xs text-charcoal/70">—</span>;
  }
  return gateFailing ? (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-rust">
      <StatusIcon kind="error" size={14} /> failing
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-gate">
      <StatusIcon kind="pass" size={14} /> passing
    </span>
  );
}

export function formatDuration(start: Date | null, end: Date | null): string {
  if (!start || !end) return "—";
  return formatMs(end.getTime() - start.getTime());
}

/** Human-friendly elapsed time from a millisecond count: "9.4s", "1m 12s". */
export function formatMs(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  if (ms < 60_000) {
    const seconds = ms / 1000;
    // One decimal under 10s ("9.4s"), whole seconds above ("42s").
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
