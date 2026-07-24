"use client";

import { useActionState } from "react";

import {
  refreshOrgConfigProbes,
  type ConfigProbeRefreshState,
} from "./actions";

const INITIAL_STATE: ConfigProbeRefreshState = { status: "idle" };

export function ConfigRecheckButton({
  slug,
  lastCheckedLabel,
}: {
  slug: string;
  lastCheckedLabel?: string | null;
}) {
  const [state, action, pending] = useActionState(
    refreshOrgConfigProbes,
    INITIAL_STATE,
  );
  const label = pending
    ? "Checking…"
    : state.status === "success"
      ? "Checked"
      : state.status === "partial"
        ? "Check incomplete"
        : state.status === "cooldown"
          ? "Checked recently"
          : state.status === "error"
            ? "Try again"
            : "Re-check";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div
        className="flex items-center gap-2"
        title={label === "Re-check" ? "Re-check now" : label}
      >
        {lastCheckedLabel && (
          <span className="font-mono text-[11px] text-charcoal/60">
            {lastCheckedLabel}
          </span>
        )}
        <form action={action}>
          <input type="hidden" name="slug" value={slug} />
          <button
            type="submit"
            disabled={pending}
            aria-label={label}
            aria-describedby={
              state.status === "idle" ? undefined : "config-recheck-status"
            }
            className="btn-secondary inline-flex h-7 w-7 items-center justify-center p-0 disabled:cursor-wait disabled:opacity-70"
          >
            {pending ? (
              <svg
                className="h-3.5 w-3.5 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  stroke="currentColor"
                  strokeWidth="2"
                  opacity="0.25"
                />
                <path
                  d="M21 12a9 9 0 0 0-9-9"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            ) : state.status === "success" ? (
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
            ) : state.status === "partial" ? (
              <svg
                className="h-3.5 w-3.5 text-rust"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3 2.5 20h19L12 3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            ) : state.status === "cooldown" ? (
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            ) : (
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
                <path d="M3 21v-5h5" />
              </svg>
            )}
          </button>
        </form>
      </div>
      {state.status !== "idle" && (
        <p
          id="config-recheck-status"
          role={
            state.status === "error" || state.status === "partial"
              ? "alert"
              : "status"
          }
          className={`max-w-64 text-right text-[11px] ${
            state.status === "error" || state.status === "partial"
              ? "text-rust"
              : "text-charcoal/60"
          }`}
        >
          {state.message}
          {(state.status === "success" || state.status === "partial") && (
            <span className="block font-mono text-[10px]">
              {new Date(state.checkedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
