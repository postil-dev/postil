import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { and, eq } from "drizzle-orm";

import {
  formatDuration,
  formatMs,
  GateBadge,
  ReviewStatusBadge,
} from "@/components/review-status";
import { getDb, schema } from "@/lib/db";
import { envelopeSchema, type Finding } from "@/lib/envelope";
import { sortFindingsForDisplay } from "@/lib/findings";
import { githubFileUrl, githubPrUrl } from "@/lib/github-links";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Review",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const SEVERITY_STYLES: Record<Finding["severity"], string> = {
  error: "border-rust text-rust",
  warn: "border-[#B58B2A] text-[#8a6a20]",
  info: "border-stone text-charcoal/70",
};

function FindingCard({
  finding,
  repoFullName,
  headSha,
}: {
  finding: Finding;
  repoFullName: string;
  headSha: string;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${SEVERITY_STYLES[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <span className="font-mono text-[11px] text-charcoal/60">{finding.kind}</span>
        <span className="font-mono text-[11px] text-charcoal/60">
          confidence {finding.confidence.toFixed(2)}
        </span>
        <a
          href={githubFileUrl(repoFullName, headSha, finding.path, finding.line, finding.endLine)}
          rel="noopener"
          className="font-mono text-[11px] text-rust hover:underline"
        >
          {finding.path}:{finding.line}
          {finding.endLine && finding.endLine > finding.line ? `-${finding.endLine}` : ""}
        </a>
      </div>
      <p className="mt-2 font-medium">{finding.title}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{finding.body}</p>
    </div>
  );
}

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const reviewId = Number(id);
  if (!Number.isInteger(reviewId) || reviewId <= 0) notFound();

  const user = await getSessionUser();
  if (!user) redirect("/login");

  const db = getDb();
  const org = (
    await db
      .select({ id: schema.organizations.id, slug: schema.organizations.slug })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1)
  )[0];
  if (!org) notFound();

  const membership = (
    await db
      .select({ id: schema.orgMembers.id })
      .from(schema.orgMembers)
      .where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)))
      .limit(1)
  )[0];
  if (!membership) notFound();

  // The org filter is part of the lookup: a review id from another org's
  // repository must 404, not leak.
  const review = (
    await db
      .select({
        id: schema.reviews.id,
        prNumber: schema.reviews.prNumber,
        headSha: schema.reviews.headSha,
        baseSha: schema.reviews.baseSha,
        sinceSha: schema.reviews.sinceSha,
        status: schema.reviews.status,
        envelope: schema.reviews.envelope,
        silent: schema.reviews.silent,
        gateFailing: schema.reviews.gateFailing,
        errorMessage: schema.reviews.errorMessage,
        queuedAt: schema.reviews.queuedAt,
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
      .where(and(eq(schema.reviews.id, reviewId), eq(schema.installations.orgId, org.id)))
      .limit(1)
  )[0];
  if (!review) notFound();

  // The jsonb column's type is a compile-time cast; re-validate before deep
  // rendering so a legacy or malformed envelope degrades to a notice instead
  // of throwing mid-render.
  const parsedEnvelope = review.envelope ? envelopeSchema.safeParse(review.envelope) : null;
  const envelope = parsedEnvelope?.success ? parsedEnvelope.data : null;
  const envelopeInvalid = parsedEnvelope !== null && !parsedEnvelope.success;
  const findings = envelope ? sortFindingsForDisplay(envelope.findings) : [];
  const resolved = envelope ? sortFindingsForDisplay(envelope.resolved) : [];
  // Defensive render cap; counts always reflect the full envelope.
  const MAX_RENDERED_FINDINGS = 200;

  return (
    <div className="mx-auto max-w-4xl px-6 py-14">
      <p className="eyebrow">
        <Link href="/reports" className="hover:underline">
          Reports
        </Link>{" "}
        /{" "}
        <Link href={`/orgs/${org.slug}`} className="hover:underline">
          {org.slug}
        </Link>{" "}
        / review #{review.id}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-4">
        <h1 className="serif-display text-3xl">
          {review.repoFullName}{" "}
          <a
            href={githubPrUrl(review.repoFullName, review.prNumber)}
            rel="noopener"
            className="text-rust hover:underline"
          >
            #{review.prNumber}
          </a>
        </h1>
        <ReviewStatusBadge status={review.status} gateFailing={review.gateFailing} />
        <GateBadge gateFailing={review.gateFailing} status={review.status} />
      </div>

      {/* Run facts */}
      <div className="card mt-6 grid gap-x-8 gap-y-2 p-5 sm:grid-cols-2">
        <p className="font-mono text-xs text-charcoal/70">
          model <span className="text-charcoal">{envelope?.modelUsed ?? "—"}</span>
        </p>
        <p className="font-mono text-xs text-charcoal/70">
          duration{" "}
          <span className="text-charcoal">
            {envelope?.durationMs
              ? formatMs(envelope.durationMs)
              : formatDuration(review.startedAt, review.finishedAt)}
          </span>
        </p>
        <p className="font-mono text-xs text-charcoal/70">
          tokens{" "}
          <span className="text-charcoal">
            {envelope
              ? `${envelope.usage.promptTokens} prompt / ${envelope.usage.completionTokens} completion`
              : "—"}
          </span>
        </p>
        <p className="font-mono text-xs text-charcoal/70">
          gate fails on <span className="text-charcoal">{envelope?.gate.failOn ?? "—"}</span>
        </p>
        <p className="font-mono text-xs text-charcoal/70">
          head <span className="text-charcoal">{review.headSha.slice(0, 12)}</span>
        </p>
        <p className="font-mono text-xs text-charcoal/70">
          base{" "}
          <span className="text-charcoal">
            {review.baseSha.slice(0, 12)}
            {review.sinceSha ? ` (incremental since ${review.sinceSha.slice(0, 12)})` : ""}
          </span>
        </p>
        <p className="font-mono text-xs text-charcoal/70">
          queued{" "}
          <span className="text-charcoal">{review.queuedAt.toISOString()}</span>
        </p>
        <p className="font-mono text-xs text-charcoal/70">
          finished{" "}
          <span className="text-charcoal">
            {review.finishedAt ? review.finishedAt.toISOString() : "—"}
          </span>
        </p>
      </div>

      {review.errorMessage && (
        <div className="card mt-6 border-rust p-5">
          <p className="eyebrow text-rust">Error</p>
          <p className="mt-2 whitespace-pre-wrap font-mono text-xs">{review.errorMessage}</p>
        </div>
      )}

      {envelope && (
        <>
          <div className="mt-8">
            <p className="eyebrow">Summary</p>
            <p className="card mt-3 whitespace-pre-wrap p-5 text-sm text-ink-soft">
              {review.silent ? "Silent review: nothing merge-relevant to say." : envelope.summary}
            </p>
          </div>

          <div className="mt-8">
            <p className="eyebrow">
              Findings ({findings.length}) · {envelope.counts.suppressed} suppressed below
              threshold · {envelope.counts.ungrounded} dropped ungrounded
            </p>
            <div className="card mt-3 divide-y divide-stone/60">
              {findings.slice(0, MAX_RENDERED_FINDINGS).map((f, i) => (
                <FindingCard
                  key={i}
                  finding={f}
                  repoFullName={review.repoFullName}
                  headSha={review.headSha}
                />
              ))}
              {findings.length > MAX_RENDERED_FINDINGS && (
                <p className="px-5 py-4 text-center text-sm text-charcoal/50">
                  and {findings.length - MAX_RENDERED_FINDINGS} more findings not shown
                </p>
              )}
              {findings.length === 0 && (
                <p className="px-5 py-8 text-center text-sm text-charcoal/50">
                  No findings shipped on this review.
                </p>
              )}
            </div>
          </div>

          {resolved.length > 0 && (
            <div className="mt-8">
              <p className="eyebrow">Resolved since the previous review ({resolved.length})</p>
              <div className="card mt-3 divide-y divide-stone/60 opacity-70">
                {resolved.slice(0, MAX_RENDERED_FINDINGS).map((f, i) => (
                  <FindingCard
                    key={i}
                    finding={f}
                    repoFullName={review.repoFullName}
                    headSha={review.headSha}
                  />
                ))}
                {resolved.length > MAX_RENDERED_FINDINGS && (
                  <p className="px-5 py-4 text-center text-sm text-charcoal/50">
                    and {resolved.length - MAX_RENDERED_FINDINGS} more not shown
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {envelopeInvalid && (
        <p className="card mt-8 p-8 text-center text-sm text-charcoal/50">
          The stored envelope does not match the current envelope contract and
          cannot be displayed.
        </p>
      )}

      {!envelope && !envelopeInvalid && !review.errorMessage && (
        <p className="card mt-8 p-8 text-center text-sm text-charcoal/50">
          {review.status === "stale"
            ? "Superseded by a later push to the pull request; this review never completed."
            : "No envelope stored yet; the review has not completed."}
        </p>
      )}
    </div>
  );
}
