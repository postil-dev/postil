import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { desc, eq, inArray, sql } from "drizzle-orm";

import {
  formatDuration,
  GateBadge,
  ReviewStatusBadge,
} from "@/components/review-status";
import { ReportsHeader } from "@/components/reports-header";
import { ReviewTriggerBadge } from "@/components/review-trigger-badge";
import { getDb, schema } from "@/lib/db";
import { githubAppInstallUrl } from "@/lib/github-app";
import { githubPrUrl } from "@/lib/github-links";
import { reviewDisplayStatus } from "@/lib/review-outcome";
import { getVerifiedSessionUser, loginRedirectPath } from "@/lib/session";
import type { ReviewTriggerSource } from "@/lib/review-trigger";

export const metadata: Metadata = {
  title: "Reports",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const verification = await getVerifiedSessionUser();
  if (!verification.ok) {
    redirect(
      await loginRedirectPath(
        verification.reason === "unauthenticated" ? undefined : "membership_verification",
      ),
    );
  }
  const user = verification.user;

  const db = getDb();
  const memberships = await db
    .select({
      orgId: schema.organizations.id,
      slug: schema.organizations.slug,
      name: schema.organizations.name,
      plan: schema.organizations.plan,
    })
    .from(schema.orgMembers)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgMembers.orgId))
    .where(eq(schema.orgMembers.userId, user.id));

  const orgIds = memberships.map((m) => m.orgId);

  // Per-org headline stats for the org cards; one grouped pass over reviews.
  const orgStats =
    orgIds.length === 0
      ? []
      : await db
          .select({
            orgId: schema.installations.orgId,
            completed: sql<number>`count(*) FILTER (WHERE ${schema.reviews.status} = 'completed')::int`,
            silent: sql<number>`count(*) FILTER (WHERE ${schema.reviews.status} = 'completed' AND ${schema.reviews.silent})::int`,
            gateFailing: sql<number>`count(*) FILTER (WHERE ${schema.reviews.gateFailing})::int`,
            last30Days: sql<number>`count(*) FILTER (WHERE ${schema.reviews.queuedAt} > now() - interval '30 days')::int`,
          })
          .from(schema.reviews)
          .innerJoin(
            schema.repositories,
            eq(schema.repositories.id, schema.reviews.repositoryId),
          )
          .innerJoin(
            schema.installations,
            eq(schema.installations.id, schema.repositories.installationId),
          )
          .where(inArray(schema.installations.orgId, orgIds))
          .groupBy(schema.installations.orgId);
  const statsByOrg = new Map(orgStats.map((s) => [s.orgId, s]));

  const reviews =
    orgIds.length === 0
      ? []
      : await db
          .select({
            id: schema.reviews.id,
            publicId: schema.reviews.publicId,
            prNumber: schema.reviews.prNumber,
            status: schema.reviews.status,
            errorMessage: schema.reviews.errorMessage,
            silent: schema.reviews.silent,
            gateFailing: schema.reviews.gateFailing,
            envelope: schema.reviews.envelope,
            startedAt: schema.reviews.startedAt,
            finishedAt: schema.reviews.finishedAt,
            queuedAt: schema.reviews.queuedAt,
            repoFullName: schema.repositories.fullName,
            orgSlug: schema.organizations.slug,
            triggerSource: schema.reviews.triggerSource,
          })
          .from(schema.reviews)
          .innerJoin(
            schema.repositories,
            eq(schema.repositories.id, schema.reviews.repositoryId),
          )
          .innerJoin(
            schema.installations,
            eq(schema.installations.id, schema.repositories.installationId),
          )
          .innerJoin(
            schema.organizations,
            eq(schema.organizations.id, schema.installations.orgId),
          )
          .where(inArray(schema.organizations.id, orgIds))
          .orderBy(desc(schema.reviews.queuedAt))
          .limit(50);

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <ReportsHeader
        login={user.login}
        addAccountUrl={memberships.length > 0 ? githubAppInstallUrl() : undefined}
      />

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {memberships.map((m) => {
          const stats = statsByOrg.get(m.orgId);
          const silenceRate =
            stats && stats.completed > 0
              ? Math.round((stats.silent / stats.completed) * 100)
              : null;
          return (
            <Link
              key={m.orgId}
              href={`/orgs/${m.slug}`}
              className="card p-5 transition-colors hover:border-gate"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{m.name}</span>
                <span className="font-mono text-xs text-gate">{m.plan}</span>
              </div>
              <div className="mt-4 flex items-end gap-2">
                <span className="serif-display text-3xl">
                  {silenceRate === null ? "—" : `${silenceRate}%`}
                </span>
                <span className="pb-1 text-xs text-charcoal/60">silent</span>
              </div>
              <p className="mt-2 font-mono text-[11px] text-charcoal/60">
                {stats?.last30Days ?? 0} reviews in 30 days · {stats?.gateFailing ?? 0} gate
                fail{(stats?.gateFailing ?? 0) === 1 ? "" : "s"} all-time
              </p>
            </Link>
          );
        })}
        {memberships.length === 0 && (
          <div className="card w-full p-8 text-center">
            <p className="serif-display text-xl">No organizations yet.</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
              Install the GitHub App on an organization or your personal
              account and it appears here on your next sign-in.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <a href={githubAppInstallUrl()} className="btn-primary inline-block">
                Install the GitHub App
              </a>
              <Link href="/api/auth/login" className="btn-secondary inline-block">
                Already installed? Re-link my account
              </Link>
            </div>
          </div>
        )}
      </div>

      {reviews.length > 0 && (
        <div className="card mt-8 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone text-left font-mono text-xs text-charcoal/50">
                <th className="px-4 py-3 font-normal">repository</th>
                <th className="px-4 py-3 font-normal">PR</th>
                <th className="px-4 py-3 font-normal">trigger</th>
                <th className="px-4 py-3 font-normal">status</th>
                <th className="px-4 py-3 font-normal">gate</th>
                <th className="px-4 py-3 font-normal">findings</th>
                <th className="px-4 py-3 font-normal">duration</th>
                <th className="px-4 py-3 font-normal">org</th>
                <th className="px-4 py-3 font-normal">report</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id} className="border-b border-stone/60 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs">{r.repoFullName}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    <a
                      href={githubPrUrl(r.repoFullName, r.prNumber)}
                      rel="noopener"
                      className="text-rust hover:underline"
                    >
                      #{r.prNumber}
                    </a>
                  </td>
                  <td className="px-4 py-2.5">
                    <ReviewTriggerBadge source={r.triggerSource as ReviewTriggerSource} />
                  </td>
                  <td className="px-4 py-2.5">
                    <ReviewStatusBadge
                      status={reviewDisplayStatus(r.status, r.errorMessage)}
                      gateFailing={r.gateFailing}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <GateBadge
                      gateFailing={r.gateFailing}
                      status={reviewDisplayStatus(r.status, r.errorMessage)}
                    />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {r.silent ? (
                      <span className="text-gate">silent</span>
                    ) : (
                      (r.envelope?.findings.length ?? "—")
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {formatDuration(r.startedAt, r.finishedAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/orgs/${r.orgSlug}`} className="text-rust hover:underline">
                      {r.orgSlug}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    <Link
                      href={`/orgs/${r.orgSlug}/runs/${r.publicId}`}
                      className="text-rust hover:underline"
                    >
                      view
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
