import { AlertTriangle, PlayCircle, RotateCcw, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminSession } from "@/lib/admin-auth";
import { type AdminDashboardFilters, getAdminDashboard } from "@/lib/admin-dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review operations",
  description: "Operator view for hosted review health and failures.",
  alternates: { canonical: "/admin/reviews" },
};

function formatDate(value: Date | null): string {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function formatDuration(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}

function statusClassName(status: string, conclusion: string | null): string {
  if (status === "failed" || conclusion === "failure") {
    return "border-destructive/40 bg-destructive/10 text-foreground";
  }
  if (status === "completed" || conclusion === "success") {
    return "border-accent/40 bg-accent/10 text-accent-foreground";
  }
  return "border-border bg-muted text-muted-foreground";
}

function queryValue(value: string | undefined): string {
  return value ?? "";
}

export default async function AdminReviewsPage({
  searchParams,
}: {
  searchParams: Promise<AdminDashboardFilters>;
}) {
  await requireAdminSession("/admin/reviews");
  const filters = await searchParams;
  const dashboard = await getAdminDashboard(filters);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 lg:px-12">
      <header className="flex flex-col gap-4 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">Admin</span>
          <h1 className="text-3xl font-semibold">Review operations</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Hosted review health, failures, costs, models, versions, and check-run diagnostics.
          </p>
        </div>
        <form
          action="/admin/reviews"
          className="grid w-full gap-2 lg:w-[42rem] lg:grid-cols-[1fr_8rem_8rem_8rem_2.75rem]"
        >
          <input
            aria-label="Search review operations"
            className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm"
            name="q"
            placeholder="Repository, SHA, status, model"
            type="search"
            defaultValue={queryValue(filters.q)}
          />
          <input
            aria-label="Install filter"
            className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm"
            name="install"
            placeholder="Install"
            defaultValue={queryValue(filters.install)}
          />
          <select
            aria-label="Status filter"
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            name="status"
            defaultValue={queryValue(filters.status)}
          >
            <option value="">Any status</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
          <select
            aria-label="Time filter"
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            name="since"
            defaultValue={queryValue(filters.since)}
          >
            <option value="">Any time</option>
            <option value="24h">24h</option>
            <option value="7d">7d</option>
            <option value="30d">30d</option>
          </select>
          <button
            aria-label="Apply filters"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary text-primary-foreground"
            type="submit"
          >
            <Search aria-hidden="true" size={16} />
          </button>
        </form>
      </header>

      <section className="grid gap-3 md:grid-cols-4 lg:grid-cols-8">
        {[
          ["Installs", dashboard.totals.installs],
          ["Repos", dashboard.totals.repositories],
          ["Reviews", dashboard.totals.reviews],
          ["Failures", dashboard.totals.failures],
          ["Findings", dashboard.totals.findings],
          ["Suppressed", dashboard.totals.suppressedCleanComments],
          ["Tokens", dashboard.totals.totalTokens],
          [
            "Avg latency",
            dashboard.totals.averageLatencyMs === null
              ? "n/a"
              : formatDuration(dashboard.totals.averageLatencyMs),
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 truncate text-xl font-semibold">
              {typeof value === "number" ? formatNumber(value) : value}
            </div>
          </div>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-4 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground lg:grid-cols-[minmax(0,1fr)_7rem_7rem_8rem_8rem_9rem]">
            <span>Review</span>
            <span>Status</span>
            <span>Findings</span>
            <span className="hidden lg:block">Latency</span>
            <span className="hidden lg:block">Tokens</span>
            <span className="hidden lg:block">Created</span>
          </div>
          {dashboard.reviews.length === 0 ? (
            <div className="p-8 text-sm text-muted-foreground">
              No review metrics match these filters.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {dashboard.reviews.map((review) => (
                <li key={review.id}>
                  <Link
                    className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-4 px-4 py-4 transition hover:bg-muted/60 lg:grid-cols-[minmax(0,1fr)_7rem_7rem_8rem_8rem_9rem]"
                    href={`/admin/reviews/${review.id}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {review.repoFullName}
                        {review.pullNumber ? `#${review.pullNumber}` : ""}
                      </span>
                      <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                        {review.headSha ?? "no sha"} · {review.triggerPath.replace(/_/g, " ")}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {review.modelUsed ?? "model unknown"}
                        {review.fallbackUsed ? " · fallback" : ""}
                      </span>
                    </span>
                    <span>
                      <span
                        className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${statusClassName(review.status, review.conclusion)}`}
                      >
                        {review.status}
                      </span>
                      {review.failureClass ? (
                        <span className="mt-2 block truncate text-xs text-muted-foreground">
                          {review.failureClass}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-sm">
                      {review.findingCount}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {review.errorFindingCount}E {review.warnFindingCount}W
                      </span>
                    </span>
                    <span className="hidden text-sm text-muted-foreground lg:block">
                      {formatDuration(review.latencyMs)}
                    </span>
                    <span className="hidden text-sm text-muted-foreground lg:block">
                      {formatNumber(review.totalTokens)}
                    </span>
                    <span className="hidden text-sm text-muted-foreground lg:block">
                      {formatDate(review.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <AlertTriangle aria-hidden="true" size={16} />
              <h2 className="text-sm font-semibold">Failure inbox</h2>
            </div>
            {dashboard.failures.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No failures in the current filter.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {dashboard.failures.map((failure) => (
                  <li className="p-4" key={failure.failureClass}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium">
                        {failure.failureClass.replace(/_/g, " ")}
                      </span>
                      <span className="rounded-md bg-muted px-2 py-1 text-xs">{failure.count}</span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{failure.nextAction}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Latest {formatDate(failure.latestAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Replay controls</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border text-sm text-muted-foreground"
                disabled
                type="button"
              >
                <RotateCcw aria-hidden="true" size={16} />
                Rerun
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border text-sm text-muted-foreground"
                disabled
                type="button"
              >
                <PlayCircle aria-hidden="true" size={16} />
                Replay
              </button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Disabled until a signed, idempotent mutation path is available.
            </p>
          </section>
        </aside>
      </section>
    </main>
  );
}
