import Link from "next/link";
import type { Metadata } from "next";
import { requireReportSession } from "@/lib/report-auth";
import { listReviewReports, reportViewerFromSession } from "@/lib/reports";

export const metadata: Metadata = {
  title: "Reports",
  description: "Browse completed Postil review reports.",
  alternates: { canonical: "/reports" },
};

function formatDate(value: Date | null): string {
  if (!value) return "Not completed";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function statusClassName(status: string): string {
  if (status === "completed") return "border-accent/40 bg-accent/10 text-accent-foreground";
  if (status === "failed") return "border-destructive/40 bg-destructive/10 text-foreground";
  return "border-border bg-muted text-muted-foreground";
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireReportSession("/reports");
  const viewer = reportViewerFromSession(session);
  const { q } = await searchParams;
  const reports = await listReviewReports({ viewer, q, limit: 100 });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-8 lg:px-12">
      <header className="flex flex-col gap-4 border-b border-border pb-6 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">Reports</span>
          <h1 className="text-3xl font-semibold">Review reports</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Authenticated access to persisted review results, failures, and check-run links.
          </p>
        </div>
        <form action="/reports" className="flex w-full gap-2 md:w-80">
          <input
            aria-label="Search reports"
            className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            name="q"
            placeholder="Repository, SHA, status"
            type="search"
            defaultValue={q ?? ""}
          />
          <button
            className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            type="submit"
          >
            Search
          </button>
        </form>
      </header>

      {reports.length === 0 ? (
        <section className="rounded-lg border border-border bg-card p-8">
          <h2 className="text-lg font-semibold">No reports found</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Reviews will appear here after the app receives GitHub events and completes a run.
          </p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-4 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground md:grid-cols-[minmax(0,1fr)_8rem_8rem_11rem]">
            <span>Pull request</span>
            <span>Status</span>
            <span>Findings</span>
            <span className="hidden md:block">Completed</span>
          </div>
          <ul className="divide-y divide-border">
            {reports.map((report) => (
              <li key={report.id}>
                <Link
                  className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] gap-4 px-4 py-4 transition hover:bg-muted/60 md:grid-cols-[minmax(0,1fr)_8rem_8rem_11rem]"
                  href={`/reports/${report.id}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {report.repoFullName}#{report.pullNumber}
                    </span>
                    <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                      {report.headSha}
                    </span>
                  </span>
                  <span>
                    <span
                      className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${statusClassName(report.status)}`}
                    >
                      {report.status}
                    </span>
                  </span>
                  <span className="text-sm">{report.findingCount}</span>
                  <span className="hidden text-sm text-muted-foreground md:block">
                    {formatDate(report.completedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
