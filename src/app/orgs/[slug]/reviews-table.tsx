"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { GateBadge, formatMs, ReviewStatusBadge } from "@/components/review-status";
import { githubPrUrl } from "@/lib/github-links";
import type { OrgReviewRow } from "@/lib/org-reviews";

const POLL_INTERVAL_MS = 5_000;
const CLOCK_INTERVAL_MS = 1_000;

const FILTERS = ["all", "running", "failed", "gate-failing"] as const;
type QuickFilter = (typeof FILTERS)[number];

function runHref(orgSlug: string, review: Pick<OrgReviewRow, "publicId">): string {
  return `/orgs/${orgSlug}/runs/${review.publicId}`;
}

function isActive(review: OrgReviewRow): boolean {
  return review.status === "queued" || review.status === "running";
}

function matchesQuickFilter(review: OrgReviewRow, filter: QuickFilter): boolean {
  if (filter === "running") return isActive(review);
  if (filter === "failed") return review.status === "failed";
  if (filter === "gate-failing") return review.gateFailing === true;
  return true;
}

function matchesTextFilter(review: OrgReviewRow, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  const gate = review.gateFailing
    ? "gate gate-failing failing"
    : review.status === "completed"
      ? "gate passing"
      : "gate pending";
  const searchable = [
    review.repoFullName,
    String(review.prNumber),
    `#${review.prNumber}`,
    review.status,
    gate,
    review.modelUsed ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase();

  return searchable.includes(normalizedQuery);
}

function reviewDuration(review: OrgReviewRow, now: number | null): string {
  if (!review.startedAt) return "n/a";
  const start = Date.parse(review.startedAt);
  const end = review.finishedAt
    ? Date.parse(review.finishedAt)
    : review.status === "running"
      ? now
      : null;
  if (end === null) return "n/a";
  return formatMs(end - start);
}

export function ReviewsTable({
  orgSlug,
  initialReviews,
}: {
  orgSlug: string;
  initialReviews: OrgReviewRow[];
}) {
  const [reviews, setReviews] = useState(initialReviews);
  const [query, setQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [now, setNow] = useState<number | null>(null);

  const visibleReviews = useMemo(
    () =>
      reviews.filter(
        (review) =>
          matchesQuickFilter(review, quickFilter) && matchesTextFilter(review, query),
      ),
    [query, quickFilter, reviews],
  );
  const hasVisibleActiveReview = visibleReviews.some(isActive);
  const hasVisibleRunningReview = visibleReviews.some(
    (review) => review.status === "running" && review.startedAt !== null,
  );

  useEffect(() => {
    if (!hasVisibleRunningReview) return;

    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasVisibleRunningReview]);

  useEffect(() => {
    if (!hasVisibleActiveReview) return;

    let stopped = false;
    let timeout: number | undefined;
    let controller: AbortController | undefined;

    const refresh = async () => {
      controller = new AbortController();
      try {
        const response = await fetch(`/api/orgs/${encodeURIComponent(orgSlug)}/reviews?limit=50`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) {
          const nextReviews = (await response.json()) as OrgReviewRow[];
          if (!stopped && Array.isArray(nextReviews)) setReviews(nextReviews);
        }
      } catch {
        // A transient refresh failure leaves the last known rows in place.
      } finally {
        if (!stopped) timeout = window.setTimeout(refresh, POLL_INTERVAL_MS);
      }
    };

    timeout = window.setTimeout(refresh, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timeout) window.clearTimeout(timeout);
      controller?.abort();
    };
  }, [hasVisibleActiveReview, orgSlug]);

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="eyebrow">Recent reviews</p>
        {hasVisibleActiveReview && (
          <p className="font-mono text-[11px] text-charcoal/50" role="status">
            updating live
          </p>
        )}
      </div>
      <div className="card mt-3 overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-stone px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block min-w-0 flex-1 sm:max-w-sm">
            <span className="sr-only">Filter recent reviews</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter repository, PR, status, gate, or model"
              className="w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs text-charcoal placeholder:text-charcoal/40 focus:border-gate focus:outline-none"
            />
          </label>
          <div className="flex flex-wrap gap-1.5" aria-label="Review status filter">
            {FILTERS.map((filter) => {
              const selected = quickFilter === filter;
              return (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setQuickFilter(filter)}
                  className={
                    selected
                      ? "rounded-full border border-charcoal bg-charcoal px-2.5 py-1 font-mono text-[11px] text-ivory"
                      : "rounded-full border border-stone px-2.5 py-1 font-mono text-[11px] text-charcoal/70 hover:border-charcoal hover:text-charcoal"
                  }
                >
                  {filter}
                </button>
              );
            })}
          </div>
        </div>
        <div className="max-h-96 overflow-auto">
          <table className="w-full min-w-[58rem] text-sm">
            <thead className="sticky top-0 z-10 bg-paper">
              <tr className="border-b border-stone text-left font-mono text-xs text-charcoal/50">
                <th className="px-4 py-3 font-normal">repository</th>
                <th className="px-4 py-3 font-normal">PR</th>
                <th className="px-4 py-3 font-normal">status</th>
                <th className="px-4 py-3 font-normal">gate</th>
                <th className="px-4 py-3 font-normal">findings</th>
                <th className="px-4 py-3 font-normal">model</th>
                <th className="px-4 py-3 font-normal">duration</th>
                <th className="px-4 py-3 font-normal">report</th>
              </tr>
            </thead>
            <tbody>
              {visibleReviews.map((review) => {
                const href = runHref(orgSlug, review);
                return (
                  <tr
                    key={review.id}
                    className="border-b border-stone/60 last:border-0 hover:bg-stone/20"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs">
                      <Link href={href} className="hover:text-rust hover:underline">
                        {review.repoFullName}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      <a
                        href={githubPrUrl(review.repoFullName, review.prNumber)}
                        rel="noopener"
                        className="text-rust hover:underline"
                      >
                        #{review.prNumber}
                      </a>
                    </td>
                    <td className="px-4 py-2.5">
                      <ReviewStatusBadge
                        status={review.status}
                        gateFailing={review.gateFailing}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <GateBadge gateFailing={review.gateFailing} status={review.status} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {review.silent ? (
                        <span className="text-gate">silent</span>
                      ) : (
                        (review.findingsCount ?? "n/a")
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-charcoal/70">
                      {review.modelUsed ?? "n/a"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {reviewDuration(review, now)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      <Link href={href} className="text-rust hover:underline">
                        view run
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {visibleReviews.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-charcoal/50">
                    {reviews.length === 0
                      ? "No reviews yet. Open a pull request on an enabled repository."
                      : "No reviews match these filters."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
