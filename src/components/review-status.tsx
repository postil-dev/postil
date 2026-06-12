import { StatusIcon, type StatusKind } from "./status-icon";

type ReviewStatus = "queued" | "running" | "completed" | "failed" | "stale";

const STATUS_ICON: Record<ReviewStatus, StatusKind | null> = {
  queued: null,
  running: null,
  completed: "pass",
  failed: "error",
  stale: null,
};

export function ReviewStatusBadge({
  status,
  gateFailing,
}: {
  status: ReviewStatus;
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
            : status === "stale"
              ? "text-charcoal/40"
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
}: {
  gateFailing: boolean | null;
  status: ReviewStatus;
}) {
  if (status !== "completed" || gateFailing === null) {
    return <span className="font-mono text-xs text-charcoal/40">—</span>;
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
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
