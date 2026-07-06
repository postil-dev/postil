import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  formatDuration,
  formatMs,
  GateBadge,
  ReviewStatusBadge,
} from "@/components/review-status";
import { getDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { saveOrgSettings, toggleRepository } from "./actions";

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
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const db = getDb();
  const org = (
    await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1)
  )[0];
  if (!org) notFound();

  const membership = await db
    .select({ id: schema.orgMembers.id })
    .from(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)))
    .limit(1);
  if (membership.length === 0) notFound();

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

  const recentReviews = await db
    .select({
      id: schema.reviews.id,
      prNumber: schema.reviews.prNumber,
      status: schema.reviews.status,
      silent: schema.reviews.silent,
      gateFailing: schema.reviews.gateFailing,
      envelope: schema.reviews.envelope,
      startedAt: schema.reviews.startedAt,
      finishedAt: schema.reviews.finishedAt,
      repoFullName: schema.repositories.fullName,
    })
    .from(schema.reviews)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(eq(schema.installations.orgId, org.id))
    .orderBy(desc(schema.reviews.queuedAt))
    .limit(30);

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

  const settings = (
    await db
      .select({
        apiBase: schema.orgSettings.apiBase,
        model: schema.orgSettings.model,
        modelCascade: schema.orgSettings.modelCascade,
        hasKey: sql<boolean>`${schema.orgSettings.apiKeyCiphertext} IS NOT NULL`,
      })
      .from(schema.orgSettings)
      .where(eq(schema.orgSettings.orgId, org.id))
      .limit(1)
  )[0];

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
        <span className="rounded-full border border-gate px-3 py-1 font-mono text-xs text-gate">
          plan: {org.plan}
        </span>
      </div>

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
          <div className="mt-6 flex h-28 items-end gap-3">
            {buckets.map((v, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <span className="font-mono text-[10px] text-charcoal/50">{v}</span>
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
          <p className="mt-4 text-sm text-ink-soft">
            Shipped findings by model confidence, across the last{" "}
            {bucketRows.length} reviews.
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

      {/* Reviews table */}
      <div className="mt-10">
        <p className="eyebrow">Recent reviews</p>
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone text-left font-mono text-xs text-charcoal/50">
                <th className="px-4 py-3 font-normal">repository</th>
                <th className="px-4 py-3 font-normal">PR</th>
                <th className="px-4 py-3 font-normal">status</th>
                <th className="px-4 py-3 font-normal">gate</th>
                <th className="px-4 py-3 font-normal">findings</th>
                <th className="px-4 py-3 font-normal">model</th>
                <th className="px-4 py-3 font-normal">duration</th>
              </tr>
            </thead>
            <tbody>
              {recentReviews.map((r) => (
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
                  <td className="px-4 py-2.5 font-mono text-xs text-charcoal/70">
                    {r.envelope?.modelUsed ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {formatDuration(r.startedAt, r.finishedAt)}
                  </td>
                </tr>
              ))}
              {recentReviews.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-charcoal/50">
                    No reviews yet. Open a pull request on an enabled repository.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
              </div>
            ))}
            {repos.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-charcoal/50">
                No repositories. Install the GitHub App on this organization.
              </p>
            )}
          </div>
        </div>

        {/* BYO settings */}
        <div>
          <p className="eyebrow">LLM settings (BYO key)</p>
          <form action={saveOrgSettings} className="card mt-3 space-y-4 p-5">
            <input type="hidden" name="slug" value={org.slug} />
            <label className="block text-sm">
              <span className="font-medium">API base</span>
              <input
                type="url"
                name="apiBase"
                defaultValue={settings?.apiBase ?? ""}
                placeholder="https://openrouter.ai/api/v1"
                className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium">Model</span>
              <input
                type="text"
                name="model"
                defaultValue={settings?.model ?? ""}
                placeholder="deepseek/deepseek-v4-pro"
                className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium">Model cascade</span>
              <input
                type="text"
                name="modelCascade"
                defaultValue={settings?.modelCascade ?? ""}
                placeholder="qwen/qwen3-coder"
                className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
              />
            </label>
            <label className="block text-sm">
              <span className="flex items-center justify-between font-medium">
                <span>API key</span>
                {settings?.hasKey && (
                  <span className="font-mono text-[11px] text-gate">
                    a key is stored (write-only)
                  </span>
                )}
              </span>
              <input
                type="password"
                name="apiKey"
                autoComplete="off"
                placeholder={settings?.hasKey ? "leave blank to keep current key" : "sk-..."}
                className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
              />
            </label>
            {settings?.hasKey && (
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" name="removeKey" className="accent-[#C24A2A]" />
                Remove the stored key (fall back to the hosted default)
              </label>
            )}
            <p className="text-xs text-charcoal/50">
              Keys are sealed with AES-256-GCM before storage and can never be
              read back from this form. Inference runs on this key at your
              provider&apos;s rates with zero markup; leave it unset to use managed
              inference.
            </p>
            <button type="submit" className="btn-primary text-sm">
              Save settings
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
