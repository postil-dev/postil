import type { Metadata } from "next";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  GitBranch,
  GitPullRequest,
  Settings2,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { requireReportSession } from "@/lib/report-auth";
import {
  getCustomerDashboard,
  type CustomerDashboard,
  type DashboardRepository,
  type DashboardReview,
} from "@/lib/dashboard";
import type { ReviewTriggerPath } from "@/lib/review-metrics";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Track Postil installations, repositories, and review history.",
  alternates: { canonical: "/dashboard" },
};

const triggerLabels: Record<ReviewTriggerPath, string> = {
  hosted_pull_request: "Hosted review",
  hosted_mention: "@postil-dev mention",
  github_action: "GitHub Action",
  cli: "CLI",
};

function formatDate(value: Date | null): string {
  if (!value) return "No reviews yet";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function formatDuration(value: number | null): string {
  if (!value) return "Not recorded";
  if (value < 1000) return `${value} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  return `${Math.round(seconds / 60)} min`;
}

function statusClassName(status: string): string {
  if (status === "failing" || status === "failed") {
    return "border-destructive/50 bg-destructive/10 text-foreground";
  }
  if (status === "active" || status === "completed") {
    return "border-accent/50 bg-accent/10 text-foreground";
  }
  return "border-border bg-muted text-muted-foreground";
}

function pathIcon(path: ReviewTriggerPath | null) {
  if (path === "github_action") return GitBranch;
  if (path === "cli") return TerminalSquare;
  if (path === "hosted_mention") return GitPullRequest;
  return ShieldCheck;
}

function SummaryTile({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs uppercase text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-accent" />
      </div>
      <div className="mt-4 text-2xl font-semibold">{value}</div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="border bg-card p-6">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

function InstallStatus({ dashboard }: { dashboard: CustomerDashboard }) {
  if (dashboard.installations.length === 0) {
    return (
      <EmptyState
        title="Connect GitHub to start reviews"
        body="Install the GitHub App for the organization you want Postil to review. Repositories and review history appear here after the first pull request event or workflow run."
        action={
          <Link
            href="/install"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            <GitPullRequest className="h-4 w-4" />
            Install GitHub App
          </Link>
        }
      />
    );
  }

  return (
    <section className="border bg-card">
      <div className="flex flex-col gap-2 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-2xl">Install status</h2>
          <p className="text-sm text-muted-foreground">
            GitHub accounts connected to this workspace.
          </p>
        </div>
        <Link
          href="/install"
          className="inline-flex items-center gap-2 text-sm font-medium text-primary"
        >
          Manage install
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      </div>
      <ul className="divide-y">
        {dashboard.installations.map((install) => (
          <li
            key={install.id}
            className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_9rem_8rem] sm:items-center"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {install.suspended ? (
                  <CircleAlert className="h-4 w-4 text-destructive" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-accent" />
                )}
                <span className="truncate font-medium">{install.accountLogin}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {install.accountType} ·{" "}
                {install.repositorySelection === "all"
                  ? "All repositories"
                  : "Selected repositories"}
              </p>
            </div>
            <span
              className={`w-max rounded-md border px-2 py-1 text-xs font-medium ${statusClassName(install.suspended ? "failed" : "active")}`}
            >
              {install.suspended ? "Needs attention" : "Connected"}
            </span>
            <span className="text-xs text-muted-foreground sm:text-right">
              {formatDate(install.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RepositoryRows({ repositories }: { repositories: DashboardRepository[] }) {
  if (repositories.length === 0) {
    return (
      <EmptyState
        title="No repositories reviewed yet"
        body="After setup, open or update a pull request, run the reusable workflow, use the CLI, or mention @postil-dev on a pull request to create the first review."
      />
    );
  }

  return (
    <section className="overflow-hidden border bg-card">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 border-b px-4 py-3 font-mono text-xs uppercase text-muted-foreground md:grid-cols-[minmax(0,1fr)_9rem_8rem_9rem_7rem]">
        <span>Repository</span>
        <span>Status</span>
        <span className="hidden md:block">Path</span>
        <span className="hidden md:block">Last review</span>
        <span className="hidden md:block">Findings</span>
      </div>
      <ul className="divide-y">
        {repositories.map((repo) => {
          const Icon = pathIcon(repo.lastTriggerPath);
          return (
            <li
              key={repo.repoFullName}
              className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_9rem_8rem_9rem_7rem] md:items-center"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{repo.repoFullName}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {repo.reviewCount} reviews · {repo.suppressedCleanCount} clean runs without filler
                </p>
              </div>
              <span
                className={`w-max rounded-md border px-2 py-1 text-xs font-medium ${statusClassName(repo.status)}`}
              >
                {repo.status === "failing"
                  ? "Attention"
                  : repo.status === "active"
                    ? "Reviewing"
                    : "Quiet"}
              </span>
              <span className="hidden items-center gap-2 text-sm text-muted-foreground md:flex">
                <Icon className="h-4 w-4" />
                {repo.lastTriggerPath ? triggerLabels[repo.lastTriggerPath] : "Waiting"}
              </span>
              <span className="hidden text-sm text-muted-foreground md:block">
                {formatDate(repo.lastReviewedAt)}
              </span>
              <span className="hidden text-sm md:block">{repo.findingCount}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ReviewRows({ reviews }: { reviews: DashboardReview[] }) {
  if (reviews.length === 0) {
    return null;
  }

  return (
    <section className="overflow-hidden border bg-card">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 border-b px-4 py-3 font-mono text-xs uppercase text-muted-foreground md:grid-cols-[minmax(0,1fr)_8rem_8rem_7rem_8rem]">
        <span>Review</span>
        <span>Outcome</span>
        <span className="hidden md:block">Path</span>
        <span className="hidden md:block">Latency</span>
        <span className="hidden md:block">Findings</span>
      </div>
      <ul className="divide-y">
        {reviews.map((review) => {
          const Icon = pathIcon(review.triggerPath);
          const reportHref = review.reviewId ? `/reports/${review.reviewId}` : null;
          const label = `${review.repoFullName}${review.pullNumber ? `#${review.pullNumber}` : ""}`;
          const content = (
            <>
              <div className="min-w-0">
                <span className="block truncate font-medium">{label}</span>
                <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                  {review.headSha ?? "No SHA"} · {formatDate(review.createdAt)}
                </span>
              </div>
              <span
                className={`w-max rounded-md border px-2 py-1 text-xs font-medium ${statusClassName(review.status)}`}
              >
                {review.conclusion ?? review.status}
              </span>
              <span className="hidden items-center gap-2 text-sm text-muted-foreground md:flex">
                <Icon className="h-4 w-4" />
                {triggerLabels[review.triggerPath]}
              </span>
              <span className="hidden text-sm text-muted-foreground md:block">
                {formatDuration(review.latencyMs)}
              </span>
              <span className="hidden text-sm md:block">
                {review.findingCount} total, {review.errorFindingCount} blocking
              </span>
            </>
          );

          return (
            <li key={review.id}>
              {reportHref ? (
                <Link
                  href={reportHref}
                  className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 px-4 py-4 transition hover:bg-muted/60 md:grid-cols-[minmax(0,1fr)_8rem_8rem_7rem_8rem] md:items-center"
                >
                  {content}
                </Link>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_8rem_8rem_7rem_8rem] md:items-center">
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default async function DashboardPage() {
  const viewer = await requireReportSession("/dashboard");
  const dashboard = await getCustomerDashboard(viewer);
  const orgName = dashboard.organization?.name ?? "Workspace";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-8 lg:px-12">
      <header className="flex flex-col gap-5 border-b pb-6 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <span className="font-mono text-xs uppercase text-muted-foreground">Dashboard</span>
          <h1 className="mt-2 text-4xl leading-tight sm:text-5xl">{orgName}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Track setup, repository review health, and recent Postil activity for the active GitHub
            organization.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/reports"
            className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium"
          >
            <Activity className="h-4 w-4" />
            Reports
          </Link>
          <Link
            href="/install"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            <GitPullRequest className="h-4 w-4" />
            Install
          </Link>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          label="Repositories"
          value={String(dashboard.totals.repositories)}
          detail="Repos with at least one tracked review."
          icon={GitBranch}
        />
        <SummaryTile
          label="Reviews"
          value={String(dashboard.totals.reviews)}
          detail="Recent runs across hosted, action, CLI, and mention paths."
          icon={ShieldCheck}
        />
        <SummaryTile
          label="Findings"
          value={String(dashboard.totals.findings)}
          detail="Total findings recorded in recent review metrics."
          icon={CircleAlert}
        />
        <SummaryTile
          label="Quiet runs"
          value={String(dashboard.totals.suppressedCleanComments)}
          detail="Clean reviews where Postil avoided a filler comment."
          icon={CheckCircle2}
        />
      </section>

      <InstallStatus dashboard={dashboard} />

      <section className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.6fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-3xl">Repositories</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Review status and configuration health.
              </p>
            </div>
          </div>
          <RepositoryRows repositories={dashboard.repositories} />
        </div>

        <aside className="flex flex-col gap-4">
          <div className="border bg-card p-5">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-accent" />
              <h2 className="font-display text-2xl">Settings</h2>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Model, provider, and repository configuration controls will appear here when
              self-service configuration is available.
            </p>
          </div>
          <div className="border bg-card p-5">
            <div className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-accent" />
              <h2 className="font-display text-2xl">Usage</h2>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Managed beta is free while billing is being prepared. Usage shown here is for
              visibility only.
            </p>
          </div>
        </aside>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-3xl">Review history</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Recent outcomes, latency, findings, noise suppression, and pull request links.
          </p>
        </div>
        <ReviewRows reviews={dashboard.reviews} />
      </section>
    </main>
  );
}
