import { PlayCircle, RotateCcw } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminSession } from "@/lib/admin-auth";
import { getAdminReviewDetail } from "@/lib/admin-dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review detail",
  description: "Hosted review diagnostic detail.",
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

function githubUrls(review: {
  repoFullName: string;
  pullNumber: number | null;
  checkRunId: number | null;
  workflowRunId: number | null;
}) {
  const repoUrl = `https://github.com/${review.repoFullName}`;
  return {
    repoUrl,
    pullUrl: review.pullNumber ? `${repoUrl}/pull/${review.pullNumber}` : null,
    checkRunUrl: review.checkRunId ? `${repoUrl}/runs/${review.checkRunId}` : null,
    workflowRunUrl: review.workflowRunId ? `${repoUrl}/actions/runs/${review.workflowRunId}` : null,
  };
}

function metadataEntries(metadata: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(metadata).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

export default async function AdminReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdminSession(`/admin/reviews/${id}`);
  const review = await getAdminReviewDetail(id);
  if (!review) notFound();

  const urls = githubUrls(review);
  const metadata = metadataEntries(review.metadataPreview);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8 lg:px-12">
      <header className="flex flex-col gap-4 border-b border-border pb-6 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <Link className="text-sm text-muted-foreground underline" href="/admin/reviews">
            Review operations
          </Link>
          <h1 className="mt-2 truncate text-3xl font-semibold">
            {review.repoFullName}
            {review.pullNumber ? `#${review.pullNumber}` : ""}
          </h1>
          <p className="mt-2 max-w-3xl truncate font-mono text-xs text-muted-foreground">
            {review.headSha ?? "no sha"} · {review.id}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm text-muted-foreground"
            disabled
            type="button"
          >
            <RotateCcw aria-hidden="true" size={16} />
            Rerun
          </button>
          <button
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm text-muted-foreground"
            disabled
            type="button"
          >
            <PlayCircle aria-hidden="true" size={16} />
            Replay
          </button>
        </div>
      </header>

      <section className="grid gap-3 md:grid-cols-4">
        {[
          ["Status", review.conclusion ? `${review.status} / ${review.conclusion}` : review.status],
          ["Failure", review.failureClass ?? "none"],
          ["Latency", formatDuration(review.latencyMs)],
          ["Tokens", formatNumber(review.totalTokens)],
          ["Findings", formatNumber(review.findingCount)],
          ["Suppressed", review.suppressedCleanComment ? "yes" : "no"],
          ["Model", review.modelUsed ?? "unknown"],
          ["Created", formatDate(review.createdAt)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 truncate text-sm font-semibold">{value}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Finding summary</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-4">
              {[
                ["Errors", review.errorFindingCount],
                ["Warnings", review.warnFindingCount],
                ["Info", review.infoFindingCount],
                ["Inline comments", review.inlineCommentCount],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border border-border p-3">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-1 text-xl font-semibold">{formatNumber(Number(value))}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Sanitized metadata</h2>
            {metadata.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No metadata was recorded for this review.
              </p>
            ) : (
              <dl className="mt-3 divide-y divide-border">
                {metadata.map(([key, value]) => (
                  <div className="grid gap-2 py-3 md:grid-cols-[12rem_1fr]" key={key}>
                    <dt className="truncate font-mono text-xs text-muted-foreground">{key}</dt>
                    <dd className="min-w-0 break-words font-mono text-xs">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-4">
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Links</h2>
            <div className="mt-3 flex flex-col gap-2 text-sm">
              <a className="underline" href={urls.repoUrl}>
                Repository
              </a>
              {urls.pullUrl ? (
                <a className="underline" href={urls.pullUrl}>
                  Pull request
                </a>
              ) : null}
              {urls.checkRunUrl ? (
                <a className="underline" href={urls.checkRunUrl}>
                  Check run
                </a>
              ) : null}
              {urls.workflowRunUrl ? (
                <a className="underline" href={urls.workflowRunUrl}>
                  Workflow run
                </a>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Versions</h2>
            <dl className="mt-3 grid gap-3 text-sm">
              {[
                ["CLI", review.cliVersion ?? "unknown"],
                ["Action", review.actionVersion ?? "unknown"],
                ["Hosted app", review.hostedAppVersion ?? "unknown"],
                ["Provider", review.modelProvider ?? "unknown"],
                ["Cascade", review.modelCascade ?? "none"],
              ].map(([label, value]) => (
                <div className="grid grid-cols-[6rem_1fr] gap-2" key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="truncate font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Execution</h2>
            <dl className="mt-3 grid gap-3 text-sm">
              {[
                ["Started", formatDate(review.startedAt)],
                ["Completed", formatDate(review.completedAt)],
                ["Timeout", formatDuration(review.timeoutMs)],
                ["Trigger path", review.triggerPath.replace(/_/g, " ")],
                ["Trigger run", review.triggerRunId ?? "unknown"],
              ].map(([label, value]) => (
                <div className="grid grid-cols-[6rem_1fr] gap-2" key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="truncate">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>
      </section>
    </main>
  );
}
