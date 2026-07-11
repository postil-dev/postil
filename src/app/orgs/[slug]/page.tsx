import type { Metadata } from "next";
import Link from "next/link";

import { and, desc, eq, sql } from "drizzle-orm";

import { formatMs } from "@/components/review-status";
import { schema } from "@/lib/db";
import { requireOrgMembership } from "@/lib/org-access";
import { getOrgReviewRows } from "@/lib/org-reviews";
import { toggleRepository } from "./actions";
import { ReviewsTable } from "./reviews-table";

export const metadata: Metadata = {
  title: "Organization",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const BUCKET_LABELS = ["0–.2", ".2–.4", ".4–.6", ".6–.8", ".8–1"] as const;

export default async function OrgDashboardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { db, org, membership } = await requireOrgMembership(slug);
  const isAdmin = membership.role === "admin";

  const suspendedInstallations = await db
    .select({ accountLogin: schema.installations.accountLogin })
    .from(schema.installations)
    .where(and(eq(schema.installations.orgId, org.id), eq(schema.installations.suspended, true)));

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

  // Confidence distribution: sum confidenceBuckets across stored envelopes.
  const bucketRows = await db
    .select({
      buckets: sql<number[]>`${schema.reviews.envelope} -> 'confidenceBuckets'`,
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
    if (Array.isArray(row.buckets)) {
      row.buckets.forEach((v, i) => {
        if (i < 5 && typeof v === "number") buckets[i] = (buckets[i] ?? 0) + v;
      });
    }
  }
  const bucketMax = Math.max(...buckets, 1);
  const bucketTicks = [bucketMax, Math.ceil(bucketMax / 2), 0];

  // Engine telemetry across completed reviews, read from stored envelopes.
  // Older envelopes lack durationMs / counts.ungrounded; COALESCE treats the
  // missing JSONB keys as 0 so they neither break the median nor inflate it.
  const telemetryAgg = (
    await db
      .select({
        // Median wall-clock duration in ms; ignore 0s (older CLIs / not recorded).
        medianDurationMs: sql<number | null>`
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY (${schema.reviews.envelope} ->> 'durationMs')::int
          ) FILTER (WHERE (${schema.reviews.envelope} ->> 'durationMs')::int > 0)
        `,
        // Total ungrounded findings dropped for not citing a changed line.
        ungrounded: sql<number>`
          COALESCE(SUM((${schema.reviews.envelope} -> 'counts' ->> 'ungrounded')::int), 0)::int
        `,
        // Findings actually shipped, summed from stored envelopes.
        shipped: sql<number>`
          COALESCE(SUM(jsonb_array_length(${schema.reviews.envelope} -> 'findings')), 0)::int
        `,
      })
      .from(schema.reviews)
      .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(and(eq(schema.installations.orgId, org.id), eq(schema.reviews.status, "completed")))
  )[0] ?? { medianDurationMs: null, ungrounded: 0, shipped: 0 };

  const medianDurationMs =
    telemetryAgg.medianDurationMs != null ? Math.round(telemetryAgg.medianDurationMs) : null;
  const ungrounded = telemetryAgg.ungrounded ?? 0;
  const shipped = telemetryAgg.shipped ?? 0;
  // Share of model findings discarded for failing to cite a changed line.
  const ungroundedRate =
    ungrounded + shipped > 0 ? Math.round((ungrounded / (ungrounded + shipped)) * 100) : null;

  const recentReviews = await getOrgReviewRows(db, org.id, 50);

  const repos = await db
    .select({
      id: schema.repositories.id,
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
          <Link href="/pricing" className="btn-primary text-xs">
            plan: {org.plan} · upgrade
          </Link>
        </div>
      </div>

      {suspendedInstallations.length > 0 && (
        <div className="card mt-6 border-rust p-5">
          <p className="text-sm">
            <span className="font-medium text-rust">
              Installation{suspendedInstallations.length === 1 ? "" : "s"} suspended.
            </span>{" "}
            The GitHub App installation on{" "}
            <span className="font-mono text-xs">
              {suspendedInstallations.map((i) => i.accountLogin).join(", ")}
            </span>{" "}
            is suspended, so no reviews run for it. Unsuspend it in GitHub under
            organization Settings → GitHub Apps.
          </p>
        </div>
      )}

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
            A clean PR gets a green check and zero comments. This number is the
            product working as designed.
          </p>
        </div>
        <div className="card p-8">
          <p className="eyebrow">Confidence distribution</p>
          <div className="mt-6 grid grid-cols-[2.5rem_1fr] gap-3">
            <div className="flex h-32 flex-col justify-between border-r border-stone/80 pr-2 text-right font-mono text-[10px] text-charcoal/55">
              {bucketTicks.map((tick, index) => (
                <span key={`${tick}-${index}`}>{tick}</span>
              ))}
            </div>
            <div className="flex h-32 items-end gap-3">
              {buckets.map((v, i) => (
                <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                  <span className="font-mono text-[10px] text-charcoal/60">{v}</span>
                  <div
                    className="w-full rounded-t-[3px] bg-gate"
                    style={{
                      height: `${Math.max((v / bucketMax) * 100, v > 0 ? 4 : 1)}%`,
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
            Shipped findings by model confidence, across the last{" "}
            {bucketRows.length} reviews. Linear scale, labeled by finding count.
          </p>
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
            its own envelope across completed reviews.
          </p>
        </div>
        <div className="card p-8">
          <p className="eyebrow">Ungrounded rate</p>
          <div className="mt-3 flex items-end gap-3">
            <span className="serif-display text-6xl">
              {ungroundedRate === null ? "—" : `${ungroundedRate}%`}
            </span>
            <span className="pb-2 text-sm text-charcoal/70">
              {ungrounded} dropped, {shipped} shipped
            </span>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            A model-quality signal: the share of model findings discarded for not
            citing a changed line, before anything reached a pull request.
          </p>
        </div>
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        {/* Repositories */}
        <div>
          <p className="eyebrow">Repositories</p>
          <div className="card mt-3 divide-y divide-stone/60">
            {repos.map((repo) => (
              <div key={repo.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="font-mono text-sm">{repo.fullName}</p>
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
                          : "rounded-card border border-stone px-3 py-1 font-mono text-xs text-charcoal/50 hover:border-charcoal hover:text-charcoal"
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
                        : "rounded-card border border-stone px-3 py-1 font-mono text-xs text-charcoal/50"
                    }
                  >
                    {repo.enabled ? "enabled" : "disabled"}
                  </span>
                )}
              </div>
            ))}
            {repos.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-charcoal/50">
                No repositories. Install the GitHub App on this organization.
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
              <p className="font-mono text-xs text-charcoal/50">
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
                    : "rounded-full border border-stone px-2.5 py-0.5 font-mono text-[11px] text-charcoal/60"
                }
              >
                {m.role}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-charcoal/50">
          Membership and roles mirror GitHub and refresh each time a member signs
          in. Admins can change settings and repository coverage; members can
          view everything on this page.
        </p>
      </div>

      <ReviewsTable orgSlug={org.slug} initialReviews={recentReviews} />
    </div>
  );
}
