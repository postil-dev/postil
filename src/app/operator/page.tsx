import type { Metadata } from "next";
import Link from "next/link";
import ReactMarkdown from "react-markdown";

import {
  formatDuration,
  GateBadge,
  ReviewStatusBadge,
} from "@/components/review-status";
import { envelopeSchema, type Finding } from "@/lib/envelope";
import { sortFindingsForDisplay } from "@/lib/findings";
import { githubFindingLocationUrl, githubPrUrl } from "@/lib/github-links";
import { requireOperatorAccess } from "@/lib/operator-access";
import { getPool } from "@/lib/db";
import {
  getPrivateMonitoringDashboard,
  type PrivateMonitoringDashboard,
} from "@/lib/private-monitoring";
import {
  getOperatorReviewRows,
  OPERATOR_REVIEW_LIMIT,
  parseOperatorReviewFilters,
  type OperatorReviewFilters,
  type OperatorReviewRow,
  type OperatorReviewStatus,
} from "@/lib/operator-reviews";

export const metadata: Metadata = {
  title: "Operator Dashboard",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const STATUSES: Array<"" | OperatorReviewStatus> = [
  "",
  "queued",
  "running",
  "completed",
  "failed",
  "stale",
  "unavailable",
];

const SEVERITY_STYLES: Record<Finding["severity"], string> = {
  error: "border-rust bg-rust/5 text-rust",
  warn: "border-[#B58B2A] bg-[#B58B2A]/5 text-[#765a18]",
  info: "border-stone bg-stone/30 text-charcoal/70",
};

function formatTimestamp(value: Date | null): string {
  if (!value) return "Not recorded";
  return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function MonitoringStatus({ monitoring }: { monitoring: PrivateMonitoringDashboard }) {
  const open = monitoring.incidents.filter((incident) => incident.state === "open");
  return (
    <section id="monitoring" className="mt-8 scroll-mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Private monitoring</p>
          <h2 className="serif-display mt-2 text-2xl">Production health</h2>
        </div>
        <p className="font-mono text-xs text-charcoal/60">
          {open.length.toLocaleString()} open · last pass {formatTimestamp(monitoring.state.lastCompletedAt)}
        </p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
            Monitor pass
          </p>
          <p className="mt-2 text-sm">{formatTimestamp(monitoring.state.lastCompletedAt)}</p>
          {monitoring.state.lastError && (
            <p className="mt-2 break-words font-mono text-xs text-rust">
              {monitoring.state.lastError}
            </p>
          )}
        </div>
        <div className="card p-4 lg:col-span-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
            Process heartbeats
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {monitoring.heartbeats.map((heartbeat) => (
              <div key={heartbeat.component} className="min-w-0">
                <p className="text-sm font-semibold">{heartbeat.component}</p>
                <p className="truncate font-mono text-xs text-charcoal/60" title={heartbeat.instanceId}>
                  {heartbeat.instanceId} · {formatTimestamp(heartbeat.observedAt)}
                </p>
              </div>
            ))}
            {monitoring.heartbeats.length === 0 && (
              <p className="text-sm text-charcoal/50">No heartbeat recorded.</p>
            )}
          </div>
        </div>
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="border-b border-stone bg-paper px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
            Incident ledger
          </p>
        </div>
        {monitoring.incidents.map((incident) => (
          <details key={incident.key} className="border-b border-stone/70 px-4 py-3 last:border-b-0" open={incident.state === "open"}>
            <summary className="cursor-pointer list-none text-sm">
              <span className={incident.state === "open" ? "font-semibold text-rust" : "text-charcoal/60"}>
                {incident.state === "open" ? "●" : "✓"} {incident.summary}
              </span>{" "}
              <span className="font-mono text-[11px] text-charcoal/50">
                {incident.severity} · {incident.group} · {incident.occurrenceCount.toLocaleString()} observation(s)
              </span>
            </summary>
            <div className="mt-3 space-y-1 text-xs text-charcoal/70">
              <p>{incident.detail}</p>
              <p className="font-mono">
                first {formatTimestamp(incident.firstDetectedAt)} · last {formatTimestamp(incident.lastDetectedAt)}
              </p>
              {incident.lastNotificationError && (
                <p className="font-mono text-rust">
                  notification attempt {incident.notificationAttempts}: {incident.lastNotificationError}
                </p>
              )}
            </div>
          </details>
        ))}
        {monitoring.incidents.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-charcoal/50">No incidents recorded.</p>
        )}
      </div>

      <div className="card mt-4 overflow-x-auto">
        <table className="w-full min-w-[38rem] text-left font-mono text-xs">
          <thead className="border-b border-stone bg-paper text-charcoal/50">
            <tr>
              <th className="px-4 py-3 font-normal">started</th>
              <th className="px-4 py-3 font-normal">status</th>
              <th className="px-4 py-3 text-right font-normal">checks</th>
              <th className="px-4 py-3 text-right font-normal">failures</th>
            </tr>
          </thead>
          <tbody>
            {monitoring.runs.map((run) => (
              <tr key={run.id} className="border-b border-stone/60 last:border-b-0">
                <td className="px-4 py-3">{formatTimestamp(run.startedAt)}</td>
                <td className="px-4 py-3">{run.status}</td>
                <td className="px-4 py-3 text-right">{run.checkCount}</td>
                <td className="px-4 py-3 text-right">{run.failureCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FilterInput({
  label,
  name,
  defaultValue,
  type = "search",
}: {
  label: string;
  name: keyof OperatorReviewFilters;
  defaultValue: string;
  type?: "search" | "date";
}) {
  return (
    <label className="min-w-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
        {label}
      </span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs text-charcoal placeholder:text-charcoal/40 focus:border-gate focus:outline-none"
      />
    </label>
  );
}

function FindingMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      skipHtml
      components={{
        p: ({ children: content }) => <p className="my-2 first:mt-0 last:mb-0">{content}</p>,
        ul: ({ children: content }) => (
          <ul className="my-2 ml-5 list-disc space-y-1">{content}</ul>
        ),
        ol: ({ children: content }) => (
          <ol className="my-2 ml-5 list-decimal space-y-1">{content}</ol>
        ),
        li: ({ children: content }) => <li className="pl-0.5">{content}</li>,
        strong: ({ children: content }) => (
          <strong className="font-semibold text-charcoal">{content}</strong>
        ),
        a: ({ href, children: content }) => (
          <a
            href={href}
            rel="nofollow noopener noreferrer"
            className="text-rust underline decoration-rust/40 underline-offset-2 hover:decoration-rust"
          >
            {content}
          </a>
        ),
        code: ({ className, children: content }) => (
          <code
            className={
              className
                ? `${className} font-mono text-xs`
                : "rounded bg-stone/70 px-1 py-0.5 font-mono text-xs text-charcoal"
            }
          >
            {content}
          </code>
        ),
        pre: ({ children: content }) => (
          <pre className="my-3 overflow-x-auto rounded-md bg-charcoal p-4 font-mono text-xs leading-relaxed text-ivory [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
            {content}
          </pre>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function FindingRow({
  finding,
  repoFullName,
  headSha,
}: {
  finding: Finding;
  repoFullName: string;
  headSha: string;
}) {
  const location = `${finding.path}:${finding.line}${
    finding.endLine && finding.endLine > finding.line ? `-${finding.endLine}` : ""
  }`;
  const locationUrl = githubFindingLocationUrl(
    repoFullName,
    headSha,
    finding.path,
    finding.line,
    finding.endLine,
  );
  return (
    <div className="border-t border-stone/60 py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${SEVERITY_STYLES[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <span className="font-mono text-[11px] text-charcoal/60">{finding.kind}</span>
        <span className="font-mono text-[11px] text-charcoal/60">
          confidence {finding.confidence.toFixed(2)}
        </span>
        {locationUrl ? (
          <a
            href={locationUrl}
            rel="noopener"
            className="font-mono text-[11px] text-rust hover:underline"
          >
            {location}
          </a>
        ) : (
          <span className="font-mono text-[11px] text-charcoal/60">{location}</span>
        )}
      </div>
      <h3 className="mt-3 text-sm font-semibold leading-snug">{finding.title}</h3>
      <div className="mt-2 text-sm leading-relaxed text-ink-soft">
        <FindingMarkdown>{finding.body}</FindingMarkdown>
      </div>
    </div>
  );
}

function checkRunUrl(repoFullName: string, checkRunId: number): string {
  return `https://github.com/${repoFullName}/runs/${checkRunId}`;
}

function ReviewContent({ review }: { review: OperatorReviewRow }) {
  const parsedEnvelope = review.envelope ? envelopeSchema.safeParse(review.envelope) : null;
  const envelope = parsedEnvelope?.success ? parsedEnvelope.data : null;
  const envelopeInvalid = parsedEnvelope !== null && !parsedEnvelope.success;
  const findings = envelope ? sortFindingsForDisplay(envelope.findings) : [];
  const resolved = envelope ? sortFindingsForDisplay(envelope.resolved) : [];
  const summary = envelope?.summary.trim() ?? "";

  return (
    <article id={`run-${review.publicId}`} className="card overflow-hidden">
      <div className="border-b border-stone bg-paper px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-charcoal/60">
              {review.orgSlug} · {review.orgName}
            </p>
            <h2 className="mt-1 break-words font-mono text-sm">
              <a
                href={`https://github.com/${review.repoFullName}`}
                rel="noopener"
                className="text-rust hover:underline"
              >
                {review.repoFullName}
              </a>{" "}
              <a
                href={githubPrUrl(review.repoFullName, review.prNumber)}
                rel="noopener"
                className="text-rust hover:underline"
              >
                #{review.prNumber}
              </a>
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ReviewStatusBadge status={review.status} gateFailing={review.gateFailing} />
            <GateBadge gateFailing={review.gateFailing} status={review.status} />
          </div>
        </div>
        <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0 border-l border-stone/70 pl-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
              Run id
            </dt>
            <dd className="mt-1 truncate font-mono" title={review.publicId}>
              <a href={`#run-${review.publicId}`} className="text-rust hover:underline">
                {review.publicId}
              </a>
            </dd>
          </div>
          <div className="min-w-0 border-l border-stone/70 pl-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
              Advisory check
            </dt>
            <dd className="mt-1 truncate font-mono">
              {review.advisoryCheckRunId ? (
                <a
                  href={checkRunUrl(review.repoFullName, review.advisoryCheckRunId)}
                  rel="noopener"
                  className="text-rust hover:underline"
                >
                  {review.advisoryCheckRunId}
                </a>
              ) : (
                "Not recorded"
              )}
            </dd>
          </div>
          <div className="min-w-0 border-l border-stone/70 pl-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
              Gate check
            </dt>
            <dd className="mt-1 truncate font-mono">
              {review.gateCheckRunId ? (
                <a
                  href={checkRunUrl(review.repoFullName, review.gateCheckRunId)}
                  rel="noopener"
                  className="text-rust hover:underline"
                >
                  {review.gateCheckRunId}
                </a>
              ) : (
                "Not recorded"
              )}
            </dd>
          </div>
          <div className="min-w-0 border-l border-stone/70 pl-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
              Queued
            </dt>
            <dd className="mt-1">{formatTimestamp(review.queuedAt)}</dd>
          </div>
          <div className="min-w-0 border-l border-stone/70 pl-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
              Duration
            </dt>
            <dd className="mt-1">{formatDuration(review.startedAt, review.finishedAt)}</dd>
          </div>
          <div className="min-w-0 border-l border-stone/70 pl-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
              Model
            </dt>
            <dd className="mt-1 truncate" title={envelope?.modelUsed}>
              {envelope?.modelUsed ?? "Not recorded"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="space-y-6 px-5 py-5">
        {review.errorMessage && (
          <section>
            <p className="eyebrow text-rust">Run error</p>
            <p className="mt-2 whitespace-pre-wrap font-mono text-xs text-rust">
              {review.errorMessage}
            </p>
          </section>
        )}

        {summary && (
          <section>
            <p className="eyebrow">Posted summary</p>
            <div className="mt-2 text-sm leading-relaxed text-ink-soft">
              <FindingMarkdown>{summary}</FindingMarkdown>
            </div>
          </section>
        )}

        {envelope && (
          <>
            <section>
              <p className="eyebrow">
                Posted findings ({findings.length}) · {envelope.counts.suppressed} suppressed ·{" "}
                {envelope.counts.ungrounded} ungrounded
              </p>
              <div className="mt-3">
                {findings.map((finding, index) => (
                  <FindingRow
                    key={`${finding.path}:${finding.line}:${index}`}
                    finding={finding}
                    repoFullName={review.repoFullName}
                    headSha={review.headSha}
                  />
                ))}
                {findings.length === 0 && (
                  <p className="text-sm text-charcoal/50">No findings shipped on this review.</p>
                )}
              </div>
            </section>

            {resolved.length > 0 && (
              <section>
                <p className="eyebrow">Resolved since previous review ({resolved.length})</p>
                <div className="mt-3 opacity-75">
                  {resolved.map((finding, index) => (
                      <FindingRow
                        key={`${finding.path}:${finding.line}:${index}`}
                        finding={finding}
                        repoFullName={review.repoFullName}
                        headSha={review.headSha}
                      />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {envelopeInvalid && (
          <p className="text-sm text-charcoal/50">
            The stored envelope does not match the current envelope contract and cannot be
            displayed.
          </p>
        )}

        {!envelope && !envelopeInvalid && !review.errorMessage && (
          <p className="text-sm text-charcoal/50">
            No envelope stored yet; this run has not posted review content.
          </p>
        )}
      </div>
    </article>
  );
}

export default async function OperatorDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters = parseOperatorReviewFilters(params);
  const { db, user } = await requireOperatorAccess();
  const [reviews, monitoring] = await Promise.all([
    getOperatorReviewRows(db, filters),
    getPrivateMonitoringDashboard(getPool()),
  ]);
  const totalRows = reviews[0]?.totalRows ?? 0;
  const shownRows = reviews.length;

  return (
    <main className="mx-auto max-w-7xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Operator</p>
          <h1 className="serif-display mt-2 text-3xl">Review and run ledger</h1>
        </div>
        <p className="font-mono text-xs text-charcoal/60">
          {user.login} · {shownRows.toLocaleString()} of {totalRows.toLocaleString()} runs
        </p>
      </div>

      <MonitoringStatus monitoring={monitoring} />

      <form className="card mt-6 grid gap-4 p-4 md:grid-cols-[1fr_1fr_10rem_10rem_10rem_auto] md:items-end">
        <FilterInput label="Organization" name="org" defaultValue={filters.org} />
        <FilterInput label="Repository" name="repo" defaultValue={filters.repo} />
        <FilterInput label="From" name="from" type="date" defaultValue={filters.from} />
        <FilterInput label="To" name="to" type="date" defaultValue={filters.to} />
        <label>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
            Status
          </span>
          <select
            name="status"
            defaultValue={filters.status}
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs text-charcoal focus:border-gate focus:outline-none"
          >
            {STATUSES.map((status) => (
              <option key={status || "all"} value={status}>
                {status || "all"}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <button type="submit" className="btn-primary px-4 py-2 text-xs">
            Filter
          </button>
          <Link href="/operator" className="btn-secondary px-4 py-2 text-xs">
            Clear
          </Link>
        </div>
      </form>

      {totalRows > OPERATOR_REVIEW_LIMIT && (
        <p className="mt-3 font-mono text-xs text-charcoal/50">
          Showing the newest {OPERATOR_REVIEW_LIMIT.toLocaleString()} matching runs. Narrow
          the filters to inspect older content.
        </p>
      )}

      <div className="mt-8 space-y-5">
        {reviews.map((review) => (
          <ReviewContent key={review.id} review={review} />
        ))}
        {reviews.length === 0 && (
          <div className="card px-5 py-10 text-center text-sm text-charcoal/50">
            No reviews match these filters.
          </div>
        )}
      </div>
    </main>
  );
}
