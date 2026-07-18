"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { formatMs, ReviewStatusBadge } from "@/components/review-status";
import type { ReviewDisplayStatus } from "@/lib/review-outcome";

const LOG_PAGE_SIZE = 500;

interface LogLine {
  seq: number;
  at: string;
  line: string;
}

interface LogResponse {
  lines: LogLine[];
  status: ReviewDisplayStatus;
  finishedAt: string | null;
}

interface LiveRunState {
  status: ReviewDisplayStatus;
  lines: LogLine[];
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recordedDurationMs: number | null;
}

const LiveRunContext = createContext<LiveRunState | null>(null);

function isReviewStatus(value: unknown): value is ReviewDisplayStatus {
  return ["queued", "running", "completed", "failed", "stale", "unavailable"].includes(
    String(value),
  );
}

function isLogResponse(value: unknown): value is LogResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LogResponse>;
  return (
    Array.isArray(candidate.lines) &&
    isReviewStatus(candidate.status) &&
    (candidate.finishedAt === null || typeof candidate.finishedAt === "string")
  );
}

function isActive(status: ReviewDisplayStatus): boolean {
  return status === "queued" || status === "running";
}

export function LiveRunProvider({
  slug,
  publicId,
  initialStatus,
  queuedAt,
  startedAt,
  initialFinishedAt,
  recordedDurationMs,
  children,
}: {
  slug: string;
  publicId: string;
  initialStatus: ReviewDisplayStatus;
  queuedAt: string;
  startedAt: string | null;
  initialFinishedAt: string | null;
  recordedDurationMs: number | null;
  children: ReactNode;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [finishedAt, setFinishedAt] = useState(initialFinishedAt);
  const latestSeq = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;

    async function poll(): Promise<void> {
      request = new AbortController();
      try {
        const response = await fetch(
          `/api/orgs/${encodeURIComponent(slug)}/runs/${encodeURIComponent(publicId)}/logs?after=${latestSeq.current}`,
          { cache: "no-store", signal: request.signal },
        );
        if (response.status === 401 || response.status === 404) return;
        if (!response.ok) throw new Error(`log request failed with ${response.status}`);

        const body: unknown = await response.json();
        if (!isLogResponse(body)) throw new Error("log response did not match its contract");
        if (stopped) return;

        if (body.lines.length > 0) {
          latestSeq.current = Math.max(latestSeq.current, ...body.lines.map((line) => line.seq));
          setLines((current) => {
            const seen = new Set(current.map((line) => line.seq));
            return [...current, ...body.lines.filter((line) => !seen.has(line.seq))].sort(
              (left, right) => left.seq - right.seq,
            );
          });
        }
        setStatus(body.status);
        setFinishedAt(body.finishedAt);
        if (body.lines.length === LOG_PAGE_SIZE) {
          timer = setTimeout(poll, 0);
        } else if (isActive(body.status)) {
          timer = setTimeout(poll, 2_000);
        }
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
        if (isActive(status)) timer = setTimeout(poll, 2_000);
      }
    }

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      request?.abort();
    };
  }, [publicId, slug, status]);

  const value = useMemo(
    () => ({ status, lines, queuedAt, startedAt, finishedAt, recordedDurationMs }),
    [status, lines, queuedAt, startedAt, finishedAt, recordedDurationMs],
  );

  return <LiveRunContext.Provider value={value}>{children}</LiveRunContext.Provider>;
}

function useLiveRun(): LiveRunState {
  const state = useContext(LiveRunContext);
  if (!state) throw new Error("live run components require LiveRunProvider");
  return state;
}

export function LiveReviewStatus({ gateFailing }: { gateFailing: boolean | null }) {
  const { status } = useLiveRun();
  return <ReviewStatusBadge status={status} gateFailing={gateFailing} />;
}

export function LiveDuration() {
  const { status, queuedAt, startedAt, finishedAt, recordedDurationMs } = useLiveRun();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive(status)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [status]);

  if (!isActive(status) && recordedDurationMs !== null) return formatMs(recordedDurationMs);
  const start = new Date(startedAt ?? queuedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return formatMs(end - start);
}

export function LiveFinishedAt() {
  const { finishedAt } = useLiveRun();
  if (!finishedAt) return "Not recorded";
  return new Date(finishedAt)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function RunLogPane() {
  const { lines, status } = useLiveRun();
  const pane = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    if (!pinnedToBottom.current || !pane.current) return;
    pane.current.scrollTop = pane.current.scrollHeight;
  }, [lines]);

  return (
    <section className="mt-8" aria-labelledby="run-log-heading">
      <div className="flex items-baseline justify-between gap-4">
        <p id="run-log-heading" className="eyebrow">
          Run log
        </p>
        <span className="font-mono text-[10px] uppercase tracking-wider text-charcoal/70">
          {isActive(status) ? "live" : `${lines.length.toLocaleString()} lines`}
        </span>
      </div>
      <div
        ref={pane}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
        className={`mt-3 overflow-auto rounded-md border border-charcoal/80 bg-[#171815] p-4 shadow-card ${
          lines.length === 0 && !isActive(status) ? "" : "h-96"
        }`}
        role="log"
        aria-live={isActive(status) ? "polite" : "off"}
      >
        {lines.length === 0 ? (
          <p className="font-mono text-xs text-ivory/45">
            {isActive(status) ? "Waiting for worker output..." : "No retained log lines."}
          </p>
        ) : (
          <ol className="space-y-1 font-mono text-xs leading-relaxed text-ivory/85">
            {lines.map((entry) => (
              <li key={entry.seq} className="grid grid-cols-[5.5rem_1fr] gap-3">
                <time className="select-none text-ivory/35" dateTime={entry.at}>
                  {new Date(entry.at).toISOString().slice(11, 19)}
                </time>
                <span className="whitespace-pre-wrap break-words">{entry.line}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
