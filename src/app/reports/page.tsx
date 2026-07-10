import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { desc, eq, inArray } from "drizzle-orm";

import {
  formatDuration,
  GateBadge,
  ReviewStatusBadge,
} from "@/components/review-status";
import { getDb, schema } from "@/lib/db";
import { githubAppInstallUrl } from "@/lib/github-app";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Reports",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

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
  const reviews =
    orgIds.length === 0
      ? []
      : await db
          .select({
            id: schema.reviews.id,
            prNumber: schema.reviews.prNumber,
            status: schema.reviews.status,
            silent: schema.reviews.silent,
            gateFailing: schema.reviews.gateFailing,
            envelope: schema.reviews.envelope,
            startedAt: schema.reviews.startedAt,
            finishedAt: schema.reviews.finishedAt,
            queuedAt: schema.reviews.queuedAt,
            repoFullName: schema.repositories.fullName,
            orgSlug: schema.organizations.slug,
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Reports</p>
          <h1 className="serif-display mt-2 text-3xl">
            Recent reviews, {user.login}
          </h1>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        {memberships.map((m) => (
          <Link
            key={m.orgId}
            href={`/orgs/${m.slug}`}
            className="card px-4 py-2.5 text-sm transition-colors hover:border-gate"
          >
            <span className="font-medium">{m.name}</span>
            <span className="ml-2 font-mono text-xs text-gate">{m.plan}</span>
          </Link>
        ))}
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
                <th className="px-4 py-3 font-normal">status</th>
                <th className="px-4 py-3 font-normal">gate</th>
                <th className="px-4 py-3 font-normal">findings</th>
                <th className="px-4 py-3 font-normal">duration</th>
                <th className="px-4 py-3 font-normal">org</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id} className="border-b border-stone/60 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs">{r.repoFullName}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">#{r.prNumber}</td>
                  <td className="px-4 py-2.5">
                    <ReviewStatusBadge status={r.status} gateFailing={r.gateFailing} />
                  </td>
                  <td className="px-4 py-2.5">
                    <GateBadge gateFailing={r.gateFailing} status={r.status} />
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
