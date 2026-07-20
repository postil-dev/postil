"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  getGateEnforcementRefreshProgress,
  refreshGateEnforcement,
  type GateEnforcementRefreshProgress,
  type GateEnforcementRefreshState,
} from "./actions";

const INITIAL_STATE: GateEnforcementRefreshState = { status: "idle", pollGeneration: 0 };
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 120;

type Progress = "idle" | "checking" | "completed" | "failed" | "timeout";
type PollOutcome = Exclude<Progress, "idle" | "checking"> | "cancelled";

type PollOptions = {
  check: () => Promise<GateEnforcementRefreshProgress>;
  wait: (delayMs: number) => Promise<void>;
  cancelled: () => boolean;
  intervalMs?: number;
  maxAttempts?: number;
};

export async function pollGateEnforcementUntilSettled({
  check,
  wait,
  cancelled,
  intervalMs = POLL_INTERVAL_MS,
  maxAttempts = MAX_POLL_ATTEMPTS,
}: PollOptions): Promise<PollOutcome> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (cancelled()) return "cancelled";
    try {
      const result = await check();
      if (cancelled()) return "cancelled";
      if (result.status === "completed") return "completed";
      if (result.status === "failed" || result.status === "missing") return "failed";
    } catch {
      if (cancelled()) return "cancelled";
    }
    if (attempt + 1 >= maxAttempts) return "timeout";
    await wait(intervalMs);
  }
  return "timeout";
}

export function GateEnforcementRecheckButton({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(refreshGateEnforcement, INITIAL_STATE);
  const [progress, setProgress] = useState<Progress>("idle");
  const router = useRouter();
  const jobId = state.status === "queued" || state.status === "active" ? state.jobId : null;

  useEffect(() => {
    if (jobId === null) return;
    const activeJobId: number = jobId;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    setProgress("checking");

    void pollGateEnforcementUntilSettled({
      check: () => getGateEnforcementRefreshProgress(slug, activeJobId),
      cancelled: () => stopped,
      wait: (delayMs) =>
        new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, delayMs);
        }),
    }).then((outcome) => {
      if (stopped || outcome === "cancelled") return;
      setProgress(outcome);
      if (outcome === "completed") router.refresh();
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
    };
  }, [jobId, router, slug, state.pollGeneration]);

  const checking = pending || progress === "checking";
  const hasError = progress === "failed" || progress === "timeout" || state.status === "error";
  const label = pending
    ? "Queuing…"
    : progress === "checking"
      ? "Checking…"
      : progress === "completed"
        ? "Checked"
        : hasError
          ? "Try again"
          : "Re-check";
  const message = progress === "completed"
    ? "Repository rules checked."
    : progress === "failed"
      ? "The check failed. Try again."
      : progress === "timeout"
        ? "The check is taking longer than expected. Try again later."
        : state.status === "error"
          ? state.message
          : checking
            ? "Checking repository rules."
            : null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <form action={action} onSubmit={() => setProgress("idle")}>
        <input type="hidden" name="slug" value={slug} />
        <button
          type="submit"
          disabled={checking}
          aria-describedby={message === null ? undefined : "gate-enforcement-status"}
          className="btn-secondary inline-flex min-w-24 items-center justify-center gap-2 text-xs disabled:cursor-wait disabled:opacity-70"
        >
          {checking ? (
            <svg
              className="h-3.5 w-3.5 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : progress === "completed" ? (
            <svg
              className="h-3.5 w-3.5 text-gate"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m5 12 4 4L19 6" />
            </svg>
          ) : null}
          {label}
        </button>
      </form>
      {message !== null && (
        <p
          id="gate-enforcement-status"
          role={hasError ? "alert" : "status"}
          className={`max-w-52 text-right text-[11px] ${
            hasError ? "text-rust" : "text-charcoal/60"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
