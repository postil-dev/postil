"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { GateBadge, formatMs, ReviewStatusBadge } from "@/components/review-status";
import { ReviewTriggerBadge } from "@/components/review-trigger-badge";
import { githubPrUrl } from "@/lib/github-links";
import type { OrgReviewRow } from "@/lib/org-reviews";
import { reviewTriggerLabel, reviewTriggerSearchTerms } from "@/lib/review-trigger";
import { boundedRetryAfterDelayMs } from "@/lib/auth-navigation";
import { formatAbsoluteTimestamp, formatRelativeTime } from "@/lib/time";

const POLL_INTERVAL_MS = 5_000;
const CLOCK_INTERVAL_MS = 1_000;

interface ReviewPollActions {
  replaceReviews: (reviews: OrgReviewRow[]) => void;
  reload: () => void;
  schedule: (delayMs: number) => void;
  stopped: () => boolean;
}

export async function handleReviewPollResponse(
  response: Response,
  actions: ReviewPollActions,
): Promise<void> {
  if (response.status === 401 || response.status === 404) {
    if (!actions.stopped()) actions.reload();
    return;
  }

  let nextPollDelayMs = POLL_INTERVAL_MS;
  if (response.ok) {
    const nextReviews: unknown = await response.json();
    if (!actions.stopped() && Array.isArray(nextReviews)) {
      actions.replaceReviews(nextReviews as OrgReviewRow[]);
    }
  } else if (response.status === 503) {
    nextPollDelayMs = boundedRetryAfterDelayMs(
      response.headers,
      POLL_INTERVAL_MS,
    );
  }

  if (!actions.stopped()) actions.schedule(nextPollDelayMs);
}

const FILTERS = ["all", "running", "failed", "unavailable", "gate-failing"] as const;
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
  if (filter === "unavailable") return review.status === "unavailable";
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
    reviewTriggerLabel(review.triggerSource),
    reviewTriggerSearchTerms(review.triggerSource),
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
  const hasVisibleStartedReview = visibleReviews.some(
    (review) => review.startedAt !== null,
  );

  useEffect(() => {
    if (!hasVisibleStartedReview) return;

    setNow(Date.now());
    const interval = window.setInterval(
      () => setNow(Date.now()),
      hasVisibleRunningReview ? CLOCK_INTERVAL_MS : 30_000,
    );
    return () => window.clearInterval(interval);
  }, [hasVisibleRunningReview, hasVisibleStartedReview]);

  useEffect(() => {
    if (!hasVisibleActiveReview) return;

    let stopped = false;
    let timeout: number | undefined;
    let controller: AbortController | undefined;

    const schedule = (delayMs: number) => {
      if (!stopped) timeout = window.setTimeout(refresh, delayMs);
    };

    const refresh = async () => {
      controller = new AbortController();
      try {
        const response = await fetch(`/api/orgs/${encodeURIComponent(orgSlug)}/reviews?limit=50`, {
          cache: "no-store",
          signal: controller.signal,
        });
        await handleReviewPollResponse(response, {
          replaceReviews: setReviews,
          reload: () => window.location.reload(),
          schedule,
          stopped: () => stopped,
        });
      } catch {
        // A transient refresh failure leaves the last known rows in place.
        schedule(POLL_INTERVAL_MS);
      }
    };

    schedule(POLL_INTERVAL_MS);
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
          <p className="font-mono text-[11px] text-charcoal/70" role="status">
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
              placeholder="Filter repository, PR, trigger, status, gate, or model"
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
          <table className="w-full min-w-[64rem] text-sm">
            <thead className="sticky top-0 z-10 bg-paper">
              <tr className="border-b border-stone text-left font-mono text-xs text-charcoal/70">
                <th className="px-4 py-3 font-normal">repository</th>
                <th className="px-4 py-3 font-normal">PR</th>
                <th className="px-4 py-3 font-normal">trigger</th>
                <th className="px-4 py-3 font-normal">status</th>
                <th className="px-4 py-3 font-normal">gate</th>
                <th className="px-4 py-3 font-normal">active findings</th>
                <th className="px-4 py-3 font-normal">model</th>
                <th className="px-4 py-3 font-normal">started</th>
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
                      <ReviewTriggerBadge source={review.triggerSource} />
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
                    <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap">
                      {review.startedAt ? (
                        <time
                          dateTime={review.startedAt}
                          title={formatAbsoluteTimestamp(review.startedAt)}
                        >
                          {now === null
                            ? formatAbsoluteTimestamp(review.startedAt)
                            : formatRelativeTime(review.startedAt, now)}
                        </time>
                      ) : (
                        "n/a"
                      )}
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
                  <td colSpan={10} className="px-4 py-8 text-center text-sm text-charcoal/70">
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
