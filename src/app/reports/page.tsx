import Link from "next/link";

import { db } from "@/db/client";
import { reviews, usageEvents } from "@/db/schema";
import { desc, gte, sql as drizzleSql } from "drizzle-orm";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  let recent: Awaited<ReturnType<typeof loadRecent>> = [];
  let silenceRate: number | null = null;
  try {
    recent = await loadRecent();
    silenceRate = await loadSilenceRate();
  } catch {
    // DB not available — render an empty state rather than 500.
  }

  return (
    <article className="container-page py-16 max-w-4xl">
      <h1 className="font-serif text-5xl mb-2">Reviews</h1>
      <p className="text-[color:var(--color-charcoal-soft)] mb-10">
        The signal-and-silence dashboard. Every review Postil has run for repos you can
        see, plus the metric that nobody else measures.
      </p>

      <div className="panel p-6 mb-10 flex items-baseline justify-between">
        <div>
          <div className="text-sm uppercase tracking-wide text-[color:var(--color-charcoal-soft)]">
            Silence rate (7 days)
          </div>
          <div className="font-serif text-5xl mt-1">
            {silenceRate === null ? "—" : `${Math.round(silenceRate * 100)}%`}
          </div>
        </div>
        <div className="text-sm text-[color:var(--color-charcoal-soft)] max-w-xs text-right">
          Share of PRs where Postil had nothing useful to say. Higher is better —
          silence is the feature.
        </div>
      </div>

      <h2 className="font-serif text-2xl mb-4">Recent reviews</h2>
      <div className="panel">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide bg-[color:var(--color-ivory-dim)]">
            <tr>
              <th className="px-4 py-3">PR</th>
              <th className="px-4 py-3">Repo</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Findings</th>
              <th className="px-4 py-3">When</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-[color:var(--color-charcoal-soft)]">
                  No reviews yet.
                </td>
              </tr>
            ) : (
              recent.map((r) => (
                <tr key={r.id} className="border-t border-[color:var(--color-stone)]">
                  <td className="px-4 py-3 font-mono">
                    <Link href={`/reports/${r.id}`}>#{r.pullNumber}</Link>
                  </td>
                  <td className="px-4 py-3">{r.repoFullName}</td>
                  <td className="px-4 py-3 capitalize">{r.status}</td>
                  <td className="px-4 py-3">{r.findingsCount}</td>
                  <td className="px-4 py-3 text-[color:var(--color-charcoal-soft)]">
                    {r.requestedAt.toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}

async function loadRecent() {
  const rows = await db
    .select({
      id: reviews.id,
      repoFullName: reviews.repoFullName,
      pullNumber: reviews.pullNumber,
      status: reviews.status,
      result: reviews.result,
      requestedAt: reviews.requestedAt,
    })
    .from(reviews)
    .orderBy(desc(reviews.requestedAt))
    .limit(20);
  return rows.map((r) => ({
    ...r,
    findingsCount: r.result?.findings?.length ?? 0,
  }));
}

async function loadSilenceRate(): Promise<number | null> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [counts] = await db
    .select({
      total: drizzleSql<number>`count(*)::int`,
      silent: drizzleSql<number>`sum(case when ${usageEvents.kind} = 'review_silent' then 1 else 0 end)::int`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since));
  const total = counts?.total ?? 0;
  if (total === 0) return null;
  return (counts?.silent ?? 0) / total;
}
