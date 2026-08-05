import type { Metadata } from "next";
import Link from "next/link";

import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { OrganizationSwitcher } from "@/components/organization-switcher";
import { PrivateBillingNotice } from "@/components/private-billing-notice";
import { formatMs } from "@/components/review-status";
import { ReviewTimeDistribution } from "@/components/review-time-distribution";
import { getPool, schema } from "@/lib/db";
import { hostedInferenceAvailable } from "@/lib/env";
import { requireOrgMembership } from "@/lib/org-access";
import { getOrgReviewRows } from "@/lib/org-reviews";
import { getRepoHealthRows } from "@/lib/repo-health";
import {
  canProcessPrivateRepository,
  requireMatchingProviderMode,
} from "@/lib/private-repository-entitlement";
import { toggleRepository } from "./actions";
import {
  AddRepositoriesLinks,
  RemovedRepositoriesNotice,
  RepoHealthBanner,
  SuspendedInstallationsNotice,
} from "./repo-health-banner";
import { ReviewsTable } from "./reviews-table";

export const metadata: Metadata = {
  title: "Organization",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const BUCKET_LABELS = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"] as const;

/** How long a repository dropped from the installation stays called out. */
const REMOVED_REPOSITORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export default async function OrgDashboardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { db, user, org, membership } = await requireOrgMembership(slug);
  const isAdmin = membership.role === "admin";
  const now = new Date();

  const installations = await db
    .select({
      githubInstallationId: schema.installations.githubInstallationId,
      accountLogin: schema.installations.accountLogin,
      accountType: schema.installations.accountType,
      suspended: schema.installations.suspended,
    })
    .from(schema.installations)
    .where(eq(schema.installations.orgId, org.id))
    .orderBy(schema.installations.accountLogin);
  const suspendedInstallations = installations.filter((installation) => installation.suspended);
  const activeInstallations = installations.filter((installation) => !installation.suspended);

  const repoHealthRows = await getRepoHealthRows(db, org.id);
  const healthRepositoryIds = repoHealthRows.map((row) => row.repositoryId);
  const liveConfigProbes = healthRepositoryIds.length > 0
    ? await db
        .select({
          repositoryId: schema.repoConfigProbes.repositoryId,
          files: schema.repoConfigProbes.files,
        })
        .from(schema.repoConfigProbes)
        .where(
          and(
            eq(schema.repoConfigProbes.ok, true),
            inArray(schema.repoConfigProbes.repositoryId, healthRepositoryIds),
          ),
        )
    : [];
  const liveConfigFilesByRepositoryId = new Map(
    liveConfigProbes.map((probe) => [probe.repositoryId, probe.files]),
  );

  const members = await db
    .select({
      id: schema.orgMembers.id,
      role: schema.orgMembers.role,
      login: schema.users.login,
      name: schema.users.name,
    })
    .from(schema.orgMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
    .where(eq(schema.orgMembers.orgId, org.id))
    .orderBy(schema.users.login);
  const providerSettings = (
    await db
      .select({ hasKey: sql<boolean>`${schema.orgSettings.apiKeyCiphertext} IS NOT NULL` })
      .from(schema.orgSettings)
      .where(eq(schema.orgSettings.orgId, org.id))
      .limit(1)
  )[0];
  const managedReviewsPaused =
    !(await hostedInferenceAvailable(getPool())) && !(providerSettings?.hasKey ?? false);

  // Silence rate across completed reviews.
  const silenceAgg = (
    await db
      .select({
        completed: sql<number>`count(*) FILTER (WHERE ${schema.reviews.status} = 'completed')::int`,
        silent: sql<number>`count(*) FILTER (WHERE ${schema.reviews.status} = 'completed' AND ${schema.reviews.silent})::int`,
      })
      .from(schema.reviews)
      .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(eq(schema.installations.orgId, org.id))
  )[0] ?? { completed: 0, silent: 0 };
  const silenceRate =
    silenceAgg.completed > 0 ? Math.round((silenceAgg.silent / silenceAgg.completed) * 100) : null;

  // Confidence distribution includes only findings whose publication receipt
  // proves they reached GitHub. Legacy unobserved envelope counts stay out.
  const bucketRows = await db
    .select({
      confidences: sql<number[]>`ARRAY(
        SELECT (finding ->> 'confidence')::double precision
        FROM jsonb_array_elements(COALESCE(${schema.reviews.envelope} -> 'findings', '[]'::jsonb)) finding
        WHERE EXISTS (
          SELECT 1 FROM finding_publications publication
          WHERE publication.review_id = ${schema.reviews.id}
            AND publication.finding_id = finding ->> 'id'
            AND publication.initial_state IN ('inline', 'checkAnnotation', 'summaryOnly', 'carried', 'inlineRejected')
        )
      )`,
      durationMs: sql<number | null>`(${schema.reviews.envelope} ->> 'durationMs')::int`,
    })
    .from(schema.reviews)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(
      and(eq(schema.installations.orgId, org.id), eq(schema.reviews.status, "completed")),
    )
    .orderBy(desc(schema.reviews.finishedAt))
    .limit(500);
  const buckets = [0, 0, 0, 0, 0];
  for (const row of bucketRows) {
    if (Array.isArray(row.confidences)) {
      for (const confidence of row.confidences) {
        if (typeof confidence !== "number") continue;
        const index = Math.min(4, Math.max(0, Math.floor(confidence * 5)));
        buckets[index] = (buckets[index] ?? 0) + 1;
      }
    }
  }
  const shippedConfidenceFindings = buckets.reduce((sum, count) => sum + count, 0);
  const bucketPercentages = buckets.map((count) =>
    shippedConfidenceFindings > 0
      ? Math.round((count / shippedConfidenceFindings) * 100)
      : 0,
  );
  const bucketPercentageMax = Math.max(...bucketPercentages, 1);
  const bucketTicks = [
    `${bucketPercentageMax}%`,
    `${Math.ceil(bucketPercentageMax / 2)}%`,
    "0%",
  ];
  const recordedDurations = bucketRows.flatMap((row) =>
    typeof row.durationMs === "number" && row.durationMs > 0 ? [row.durationMs] : [],
  );
  const sortedDurations = [...recordedDurations].sort((left, right) => left - right);
  const durationMiddle = Math.floor(sortedDurations.length / 2);
  const medianDurationMs =
    sortedDurations.length === 0
      ? null
      : Math.round(
          sortedDurations.length % 2 === 0
            ? ((sortedDurations[durationMiddle - 1] ?? 0) +
                (sortedDurations[durationMiddle] ?? 0)) /
                2
            : (sortedDurations[durationMiddle] ?? 0),
        );

  // Engine telemetry across completed reviews, read from stored envelopes.
  // Older envelopes lack durationMs / counts.ungrounded; COALESCE treats the
  // missing JSONB keys as 0 so they neither break the median nor inflate it.
  const telemetryAgg = (
    await db
      .select({
        // Total ungrounded findings dropped for not citing a changed line.
        ungrounded: sql<number>`
          COALESCE(SUM((${schema.reviews.envelope} -> 'counts' ->> 'ungrounded')::int), 0)::int
        `,
        // Findings proven shipped by immutable publication receipts.
        shipped: sql<number>`
          COALESCE((
            SELECT count(*) FROM finding_publications publication
            INNER JOIN reviews published_review ON published_review.id = publication.review_id
            INNER JOIN repositories published_repository ON published_repository.id = published_review.repository_id
            INNER JOIN installations published_installation ON published_installation.id = published_repository.installation_id
            WHERE published_installation.org_id = ${org.id}
              AND published_review.status = 'completed'
              AND publication.initial_state IN ('inline', 'checkAnnotation', 'summaryOnly', 'carried', 'inlineRejected')
          ), 0)::int
        `,
      })
      .from(schema.reviews)
      .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(and(eq(schema.installations.orgId, org.id), eq(schema.reviews.status, "completed")))
  )[0] ?? { ungrounded: 0, shipped: 0 };
  const ungrounded = telemetryAgg.ungrounded ?? 0;
  const shipped = telemetryAgg.shipped ?? 0;
  // Comparison of ungrounded drops with findings that reached pull requests.
  // Suppressed findings are intentionally outside this displayed comparison.
  const ungroundedRate =
    ungrounded + shipped > 0 ? Math.round((ungrounded / (ungrounded + shipped)) * 100) : null;

  const recentReviews = await getOrgReviewRows(db, org.id, 50);

  const repos = await db
    .select({
      id: schema.repositories.id,
      githubRepoId: schema.repositories.githubRepoId,
      fullName: schema.repositories.fullName,
      private: schema.repositories.private,
      enabled: schema.repositories.enabled,
    })
    .from(schema.repositories)
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(eq(schema.installations.orgId, org.id))
    .orderBy(schema.repositories.fullName);

  // GitHub's repository picker replaces the whole selection when it is saved,
  // so a second save from a stale page silently drops a repository that was
  // just added. Postil then stops receiving that repository's events entirely
  // and cannot report the gap from the pull request side, so the removal is
  // surfaced here against the repositories the installation still covers.
  const trackedGithubRepoIds = new Set(repos.map((repo) => repo.githubRepoId));
  const recentlyRemovedRepos = (
    await db
      .selectDistinctOn([schema.repositoryEnablementEvents.githubRepoId], {
        githubRepoId: schema.repositoryEnablementEvents.githubRepoId,
        fullName: schema.repositoryEnablementEvents.repositoryFullName,
        occurredAt: schema.repositoryEnablementEvents.occurredAt,
        action: schema.repositoryEnablementEvents.action,
      })
      .from(schema.repositoryEnablementEvents)
      .where(
        and(
          eq(schema.repositoryEnablementEvents.orgId, org.id),
          inArray(schema.repositoryEnablementEvents.source, [
            "github_installation",
            "github_uninstall",
          ]),
          gt(
            schema.repositoryEnablementEvents.occurredAt,
            new Date(now.getTime() - REMOVED_REPOSITORY_WINDOW_MS),
          ),
        ),
      )
      .orderBy(
        schema.repositoryEnablementEvents.githubRepoId,
        desc(schema.repositoryEnablementEvents.occurredAt),
        desc(schema.repositoryEnablementEvents.id),
      )
  ).filter(
    (event) => event.action === "disable" && !trackedGithubRepoIds.has(event.githubRepoId),
  );
  const rawPrivateAccess =
    isAdmin && repos.some((repo) => repo.private && repo.enabled)
      ? await canProcessPrivateRepository(db, {
          orgId: org.id,
          repositoryPrivate: true,
        })
      : null;
  const privateAccess = rawPrivateAccess
    ? requireMatchingProviderMode(rawPrivateAccess, providerSettings?.hasKey ?? false)
    : null;
  const unreadNotifications = (
    await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.customerNotificationEvents)
      .leftJoin(
        schema.customerNotificationReads,
        and(
          eq(
            schema.customerNotificationReads.eventId,
            schema.customerNotificationEvents.id,
          ),
          eq(schema.customerNotificationReads.userId, user.id),
        ),
      )
      .where(
        and(
          eq(schema.customerNotificationEvents.orgId, org.id),
          sql`${schema.customerNotificationEvents.expiresAt} > now()`,
          isAdmin
            ? or(
                eq(schema.customerNotificationEvents.visibility, "members"),
                eq(schema.customerNotificationEvents.visibility, "admins"),
              )
            : eq(schema.customerNotificationEvents.visibility, "members"),
          isNull(schema.customerNotificationReads.id),
        ),
      )
  )[0]?.count ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">
            <Link href="/reports" className="hover:underline">
              Reports
            </Link>{" "}
            / {org.slug}
          </p>
          <h1 className="serif-display mt-2 text-3xl">{org.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <OrganizationSwitcher currentSlug={org.slug} userId={user.id} />
          <Link
            href={`/orgs/${org.slug}/notifications`}
            className="btn-secondary inline-flex items-center gap-2 text-xs"
          >
            Notifications
            {unreadNotifications > 0 && (
              <span
                aria-label={`${unreadNotifications} unread notification${unreadNotifications === 1 ? "" : "s"}`}
                className="inline-flex min-w-5 items-center justify-center rounded-full bg-gate px-1.5 py-0.5 font-mono text-[10px] leading-none text-white"
              >
                {unreadNotifications > 99 ? "99+" : unreadNotifications}
              </span>
            )}
          </Link>
          {isAdmin && (
            <>
              <Link href={`/orgs/${org.slug}/billing`} className="btn-secondary text-xs">
                Billing
              </Link>
              <Link href={`/orgs/${org.slug}/settings`} className="btn-secondary text-xs">
                Settings
              </Link>
            </>
          )}
          <Link
            href="/pricing"
            aria-label={`${org.plan} plan. View plans and upgrade.`}
            className="inline-flex items-center gap-1.5 rounded-full border border-stone bg-white/40 px-3 py-1.5 font-mono text-[11px] text-charcoal/70 transition-colors hover:border-gate hover:text-gate focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gate"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m12 3 7 4-7 4-7-4 7-4Z" />
              <path d="m5 12 7 4 7-4M5 17l7 4 7-4" />
            </svg>
            {org.plan.charAt(0).toUpperCase() + org.plan.slice(1)}
            <span aria-hidden="true">·</span>
            <span>Upgrade</span>
          </Link>
        </div>
      </div>

      <SuspendedInstallationsNotice
        installations={suspendedInstallations}
        isAdmin={isAdmin}
      />

      <PrivateBillingNotice orgSlug={org.slug} decision={privateAccess} />

      {managedReviewsPaused && (
        <div className="card mt-6 p-5">
          <p className="text-sm">
            <span className="font-medium">Managed reviews are paused.</span>{" "}
            Postil is validating its hosted model roster. GitHub checks remain neutral,
            and no review runs while paused.
          </p>
          {isAdmin && (
            <Link href={`/orgs/${org.slug}/settings`} className="btn-secondary mt-3 text-xs">
              {privateAccess?.entitlement?.subscriptionMode === "hosted"
                ? "View inference settings"
                : "Use your own model provider"}
            </Link>
          )}
        </div>
      )}

      <RepoHealthBanner
        slug={org.slug}
        rows={repoHealthRows}
        now={now}
        managedReviewsPaused={managedReviewsPaused}
        liveConfigFilesByRepositoryId={liveConfigFilesByRepositoryId}
      />

      {/* Metrics */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="card p-8">
          <p className="eyebrow">Silence rate</p>
          <div className="mt-3 flex items-end gap-3">
            <span className="serif-display text-6xl">
              {silenceRate === null ? "—" : `${silenceRate}%`}
            </span>
            <span className="pb-2 text-sm text-charcoal/70">
              of {silenceAgg.completed} completed reviews said nothing
            </span>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            Review yield, measured as how often Postil had no finding worth posting.
            It describes reviewer output frequency, not commit quality. Read it with
            finding precision and repository mix.
          </p>
        </div>
        <div className="card p-8">
          <p className="eyebrow">Confidence distribution</p>
          <p className="mt-2 text-xs text-charcoal/70">
            Higher is better. Bars show the share of shipped findings on a linear scale.
          </p>
          <div className="mt-6 grid grid-cols-[2.5rem_1fr] gap-3">
            <div className="flex h-32 flex-col justify-between border-r border-stone/80 pr-2 text-right font-mono text-[10px] text-charcoal/70">
              {bucketTicks.map((tick, index) => (
                <span key={`${tick}-${index}`}>{tick}</span>
              ))}
            </div>
            <div className="flex h-32 items-end gap-3">
              {buckets.map((v, i) => (
                <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                  <span className="font-mono text-[10px] text-charcoal/70">
                    {bucketPercentages[i]}%
                  </span>
                  <div
                    role="img"
                    tabIndex={0}
                    aria-label={`${BUCKET_LABELS[i]} confidence: ${v} of ${shippedConfidenceFindings} shipped findings, ${bucketPercentages[i]} percent`}
                    className="w-full rounded-t-[3px] bg-gate"
                    title={`${v} of ${shippedConfidenceFindings} shipped findings (${bucketPercentages[i]}%) scored ${BUCKET_LABELS[i]} confidence`}
                    style={{
                      height:
                        v > 0
                          ? `${Math.max(
                              ((bucketPercentages[i] ?? 0) / bucketPercentageMax) * 100,
                              4,
                            )}%`
                          : "0",
                      opacity: 0.45 + i * 0.13,
                    }}
                  />
                  <span className="font-mono text-[10px] text-charcoal/70">
                    {BUCKET_LABELS[i]}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            {shippedConfidenceFindings} shipped findings across the latest{" "}
            {bucketRows.length} completed reviews.
          </p>
          <details className="mt-3 text-xs text-charcoal/70">
            <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gate">
              Raw counts
            </summary>
            <ul className="mt-2 grid gap-1 font-mono text-[11px] sm:grid-cols-2">
              {buckets.map((count, index) => (
                <li key={BUCKET_LABELS[index]}>
                  {BUCKET_LABELS[index]}: {count} finding{count === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      {/* Engine telemetry */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="card p-8">
          <p className="eyebrow">Median review time</p>
          <div className="mt-3 flex items-end gap-3">
            <span className="serif-display text-6xl">
              {medianDurationMs === null ? "—" : formatMs(medianDurationMs)}
            </span>
            <span className="pb-2 text-sm text-charcoal/70">engine wall-clock</span>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            Median time the review engine spends per pull request, measured from
            its own envelope across the latest 500 completed reviews.
          </p>
          <ReviewTimeDistribution durations={recordedDurations} />
        </div>
        <div className="card p-8">
          <p className="eyebrow">Ungrounded comparison</p>
          <div className="mt-3 flex items-end gap-3">
            <span className="serif-display text-6xl">
              {ungroundedRate === null ? "—" : `${ungroundedRate}%`}
            </span>
            <span className="pb-2 text-sm text-charcoal/70">
              {ungrounded} dropped · {shipped} reached pull requests
            </span>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            Across {silenceAgg.completed} completed reviews, this compares findings
            discarded for not citing a changed line with findings that reached pull
            requests. Policy-suppressed findings are excluded.
          </p>
        </div>
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        {/* Repositories */}
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="eyebrow">Repositories</p>
            <AddRepositoriesLinks installations={activeInstallations} isAdmin={isAdmin} />
          </div>
          <RemovedRepositoriesNotice repositories={recentlyRemovedRepos} now={now} />
          <div className="card mt-3 divide-y divide-stone/60">
            {repos.map((repo) => (
              <div key={repo.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <a
                    href={`https://github.com/${repo.fullName}`}
                    className="font-mono text-sm hover:underline"
                    rel="noopener noreferrer"
                  >
                    {repo.fullName}
                  </a>
                  <p className="font-mono text-[11px] text-charcoal/70">
                    {repo.private ? "private" : "public"}
                  </p>
                </div>
                {isAdmin ? (
                  <form action={toggleRepository}>
                    <input type="hidden" name="slug" value={org.slug} />
                    <input type="hidden" name="repositoryId" value={repo.id} />
                    <input type="hidden" name="enable" value={repo.enabled ? "false" : "true"} />
                    <button
                      type="submit"
                      className={
                        repo.enabled
                          ? "rounded-card border border-gate px-3 py-1 font-mono text-xs text-gate hover:bg-gate hover:text-ivory"
                          : "rounded-card border border-stone px-3 py-1 font-mono text-xs text-charcoal/70 hover:border-charcoal hover:text-charcoal"
                      }
                    >
                      {repo.enabled ? "enabled" : "disabled"}
                    </button>
                  </form>
                ) : (
                  <span
                    className={
                      repo.enabled
                        ? "rounded-card border border-gate px-3 py-1 font-mono text-xs text-gate"
                        : "rounded-card border border-stone px-3 py-1 font-mono text-xs text-charcoal/70"
                    }
                  >
                    {repo.enabled ? "enabled" : "disabled"}
                  </span>
                )}
              </div>
            ))}
            {repos.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-charcoal/70">
                {activeInstallations.length > 0
                  ? "No repositories yet. Choose the repositories this installation covers on GitHub."
                  : "No repositories. Install the GitHub App on this organization."}
              </p>
            )}
          </div>
        </div>

        <div>
          <p className="eyebrow">Organization settings</p>
          <div className="card mt-3 space-y-4 p-5 text-sm">
            <p className="text-ink-soft">
              Model, BYOK, and hosted review configuration live on a dedicated
              admin page.
            </p>
            <p className="text-xs text-charcoal/70">
              Review configuration precedence is repository config from the default
              branch, then hosted organization config, then Postil defaults. Each
              artifact is resolved independently.
            </p>
            {isAdmin ? (
              <Link href={`/orgs/${org.slug}/settings`} className="btn-primary text-xs">
                Open settings
              </Link>
            ) : (
              <p className="font-mono text-xs text-charcoal/70">
                Changing organization settings requires the admin role.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Members */}
      <div className="mt-10">
        <p className="eyebrow">Members</p>
        <div className="card mt-3 divide-y divide-stone/60">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="font-mono text-sm">{m.login}</p>
                {m.name && <p className="text-[11px] text-charcoal/70">{m.name}</p>}
              </div>
              <span
                className={
                  m.role === "admin"
                    ? "rounded-full border border-gate px-2.5 py-0.5 font-mono text-[11px] text-gate"
                    : "rounded-full border border-stone px-2.5 py-0.5 font-mono text-[11px] text-charcoal/70"
                }
              >
                {m.role}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-charcoal/70">
          Membership and roles mirror GitHub and refresh each time a member signs
          in. Admins can change settings and repository coverage; members can
          view everything on this page.
        </p>
      </div>

      <ReviewsTable orgSlug={org.slug} initialReviews={recentReviews} />
    </div>
  );
}
