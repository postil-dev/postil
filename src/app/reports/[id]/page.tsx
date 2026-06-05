import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireReportSession } from "@/lib/report-auth";
import { getReviewReport, reportViewerFromSession } from "@/lib/reports";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Report detail",
  description: "Inspect a Postil review report.",
};

function formatDate(value: Date | null): string {
  if (!value) return "Not completed";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone: "UTC",
  }).format(value);
}

function resultJson(result: unknown): string {
  return JSON.stringify(result ?? {}, null, 2);
}

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireReportSession(`/reports/${id}`);
  const report = await getReviewReport(id, reportViewerFromSession(session));

  if (!report) notFound();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-4 py-6 sm:px-8 lg:px-12">
      <header className="flex flex-col gap-4 border-b border-border pb-6">
        <Link className="text-sm text-muted-foreground underline" href="/reports">
          Back to reports
        </Link>
        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Review report
          </span>
          <h1 className="break-words text-3xl font-semibold">
            {report.repoFullName}#{report.pullNumber}
          </h1>
          <p className="font-mono text-xs text-muted-foreground">{report.headSha}</p>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Status</p>
          <p className="mt-2 text-lg font-semibold">{report.status}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Findings</p>
          <p className="mt-2 text-lg font-semibold">{report.findingCount}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Check run</p>
          <p className="mt-2 text-lg font-semibold">{report.checkRunId ?? "None"}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Completed</p>
          <p className="mt-2 text-sm">{formatDate(report.completedAt)}</p>
        </div>
      </section>

      {report.errorMessage ? (
        <section className="rounded-lg border border-destructive/40 bg-card p-4">
          <h2 className="text-lg font-semibold">Failure</h2>
          <p className="mt-2 text-sm text-muted-foreground">{report.errorMessage}</p>
        </section>
      ) : null}

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-lg font-semibold">Result JSON</h2>
        </div>
        <pre className="max-h-[36rem] overflow-auto p-4 text-xs leading-6">
          <code>{resultJson(report.result)}</code>
        </pre>
      </section>
    </main>
  );
}
