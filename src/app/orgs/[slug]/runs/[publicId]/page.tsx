import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";

import { and, eq, isNotNull } from "drizzle-orm";

import { GateBadge } from "@/components/review-status";
import { MODELS } from "@/data/models";
import { schema } from "@/lib/db";
import { envelopeSchema, type Finding } from "@/lib/envelope";
import { sortFindingsForDisplay } from "@/lib/findings";
import { githubFileUrl, githubPrUrl } from "@/lib/github-links";
import { requireOrgMembership } from "@/lib/org-access";

import {
  LiveDuration,
  LiveFinishedAt,
  LiveReviewStatus,
  LiveRunProvider,
  RunLogPane,
} from "./live-run";

export const metadata: Metadata = {
  title: "Review run",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const SEVERITY_STYLES: Record<Finding["severity"], string> = {
  error: "border-rust bg-rust/5 text-rust",
  warn: "border-[#B58B2A] bg-[#B58B2A]/5 text-[#765a18]",
  info: "border-stone bg-stone/30 text-charcoal/70",
};

const MODEL_PRICES = new Map(MODELS.map((model) => [model.id, model.pricePerToken]));

interface UsageEvent {
  promptTokens: number;
  completionTokens: number;
  modelUsed: string | null;
}

function estimateUsageCost(events: UsageEvent[]): number | null {
  if (events.length === 0) return null;
  let total = 0;
  for (const event of events) {
    if (!event.modelUsed) return null;
    const price = MODEL_PRICES.get(event.modelUsed);
    if (!price) return null;
    total += event.promptTokens * price.input + event.completionTokens * price.output;
  }
  return total;
}

function formatEstimatedCost(cost: number): string {
  return cost.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cost < 0.01 ? 4 : 2,
    maximumFractionDigits: cost < 0.01 ? 4 : 2,
  });
}

function formatTimestamp(value: Date | null): string {
  if (!value) return "Not recorded";
  return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function RunFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border-l border-stone/70 pl-3">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/50">
        {label}
      </dt>
      <dd className="mt-1 min-w-0 truncate text-xs text-charcoal" title={typeof children === "string" ? children : undefined}>
        {children}
      </dd>
    </div>
  );
}

function FindingMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      skipHtml
      components={{
        p: ({ children: content }) => <p className="my-2 first:mt-0 last:mb-0">{content}</p>,
        ul: ({ children: content }) => (
          <ul className="my-2 ml-5 list-disc space-y-1">{content}</ul>
        ),
        ol: ({ children: content }) => (
          <ol className="my-2 ml-5 list-decimal space-y-1">{content}</ol>
        ),
        li: ({ children: content }) => <li className="pl-0.5">{content}</li>,
        strong: ({ children: content }) => (
          <strong className="font-semibold text-charcoal">{content}</strong>
        ),
        a: ({ href, children: content }) => (
          <a
            href={href}
            rel="nofollow noopener noreferrer"
            className="text-rust underline decoration-rust/40 underline-offset-2 hover:decoration-rust"
          >
            {content}
          </a>
        ),
        code: ({ className, children: content }) => (
          <code
            className={
              className
                ? `${className} font-mono text-xs`
                : "rounded bg-stone/70 px-1 py-0.5 font-mono text-xs text-charcoal"
            }
          >
            {content}
          </code>
        ),
        pre: ({ children: content }) => (
          <pre className="my-3 overflow-x-auto rounded-md bg-charcoal p-4 font-mono text-xs leading-relaxed text-ivory [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
            {content}
          </pre>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function FindingCard({
  finding,
  repoFullName,
  headSha,
  reviewUrl,
}: {
  finding: Finding;
  repoFullName: string;
  headSha: string;
  reviewUrl: string;
}) {
  return (
    <article className="px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${SEVERITY_STYLES[finding.severity]}`}
        >
          severity: {finding.severity}
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
      <h2 className="mt-3 text-base font-semibold leading-snug">
        <a href={reviewUrl} rel="noopener" className="hover:text-rust hover:underline">
          {finding.title}
        </a>
      </h2>
      <div className="mt-2 text-sm leading-relaxed text-ink-soft">
        <FindingMarkdown>{finding.body}</FindingMarkdown>
      </div>
    </article>
  );
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ slug: string; publicId: string }>;
}) {
  const { slug, publicId } = await params;
  if (!UUID_PATTERN.test(publicId)) notFound();

  const { db, org } = await requireOrgMembership(slug);

  // The org filter is part of the lookup: a public id from another org's
  // repository must 404, not leak.
  const review = (
    await db
      .select({
        id: schema.reviews.id,
        publicId: schema.reviews.publicId,
        prNumber: schema.reviews.prNumber,
        headSha: schema.reviews.headSha,
        status: schema.reviews.status,
        envelope: schema.reviews.envelope,
        gateFailing: schema.reviews.gateFailing,
        errorMessage: schema.reviews.errorMessage,
        advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
        gateCheckRunId: schema.reviews.gateCheckRunId,
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
      .where(and(eq(schema.reviews.publicId, publicId), eq(schema.installations.orgId, org.id)))
      .limit(1)
  )[0];
  if (!review) notFound();

  const [usageEvents, byokSettings] = await Promise.all([
    db
      .select({
        id: schema.usageEvents.id,
        promptTokens: schema.usageEvents.promptTokens,
        completionTokens: schema.usageEvents.completionTokens,
        modelUsed: schema.usageEvents.modelUsed,
        createdAt: schema.usageEvents.createdAt,
      })
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.reviewId, review.id))
      .orderBy(schema.usageEvents.createdAt, schema.usageEvents.id),
    db
      .select({ orgId: schema.orgSettings.orgId })
      .from(schema.orgSettings)
      .where(
        and(
          eq(schema.orgSettings.orgId, org.id),
          isNotNull(schema.orgSettings.apiKeyCiphertext),
        ),
      )
      .limit(1),
  ]);
  const usesByok = byokSettings.length > 0;

  // The jsonb column's type is a compile-time cast; re-validate before deep
  // rendering so a legacy or malformed envelope degrades to a notice instead
  // of throwing mid-render.
  const parsedEnvelope = review.envelope ? envelopeSchema.safeParse(review.envelope) : null;
  const envelope = parsedEnvelope?.success ? parsedEnvelope.data : null;
  const envelopeInvalid = parsedEnvelope !== null && !parsedEnvelope.success;
  const findings = envelope ? sortFindingsForDisplay(envelope.findings) : [];
  const resolved = envelope ? sortFindingsForDisplay(envelope.resolved) : [];
  const summary = envelope?.summary.trim() ?? "";
  const estimatedCost = usesByok ? estimateUsageCost(usageEvents) : null;
  const prUrl = githubPrUrl(review.repoFullName, review.prNumber);
  const reviewUrl = review.advisoryCheckRunId
    ? `https://github.com/${review.repoFullName}/runs/${review.advisoryCheckRunId}`
    : prUrl;
  const MAX_RENDERED_FINDINGS = 200;

  return (
    <LiveRunProvider
      slug={org.slug}
      publicId={review.publicId}
      initialStatus={review.status}
      queuedAt={review.queuedAt.toISOString()}
      startedAt={review.startedAt?.toISOString() ?? null}
      initialFinishedAt={review.finishedAt?.toISOString() ?? null}
      recordedDurationMs={envelope?.durationMs ?? null}
    >
      <main className="mx-auto max-w-5xl px-6 py-12">
        <p className="eyebrow">
          <Link href="/reports" className="hover:underline">
            Reports
          </Link>{" "}
          /{" "}
          <Link href={`/orgs/${org.slug}`} className="hover:underline">
            {org.slug}
          </Link>{" "}
          / run {review.publicId}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <h1 className="serif-display text-3xl">
            {review.repoFullName}{" "}
            <a href={prUrl} rel="noopener" className="text-rust hover:underline">
              #{review.prNumber}
            </a>
          </h1>
          <LiveReviewStatus gateFailing={review.gateFailing} />
          <GateBadge gateFailing={review.gateFailing} status={review.status} />
        </div>

        <dl className="card mt-5 grid grid-cols-2 gap-x-3 gap-y-4 p-4 sm:grid-cols-3 lg:grid-cols-4">
          <RunFact label="Repository">
            <a href={`https://github.com/${review.repoFullName}`} rel="noopener" className="text-rust hover:underline">
              {review.repoFullName}
            </a>
          </RunFact>
          <RunFact label="Pull request">
            <a href={prUrl} rel="noopener" className="text-rust hover:underline">
              #{review.prNumber}
            </a>
          </RunFact>
          <RunFact label="Commit">
            <a
              href={`https://github.com/${review.repoFullName}/commit/${review.headSha}`}
              rel="noopener"
              className="font-mono text-rust hover:underline"
              title={review.headSha}
            >
              {review.headSha.slice(0, 12)}
            </a>
          </RunFact>
          <RunFact label="Model">{envelope?.modelUsed ?? "Not recorded"}</RunFact>
          <RunFact label="Status">
            <LiveReviewStatus gateFailing={review.gateFailing} />
          </RunFact>
          <RunFact label="Duration">
            <LiveDuration />
          </RunFact>
          <RunFact label="Queued">{formatTimestamp(review.queuedAt)}</RunFact>
          <RunFact label="Started">{formatTimestamp(review.startedAt)}</RunFact>
          <RunFact label="Finished">
            <LiveFinishedAt />
          </RunFact>
          <RunFact label="Advisory check">
            {review.advisoryCheckRunId ? (
              <a href={reviewUrl} rel="noopener" className="text-rust hover:underline">
                view on GitHub
              </a>
            ) : (
              "Not recorded"
            )}
          </RunFact>
          <RunFact label="Gate check">
            {review.gateCheckRunId ? (
              <a
                href={`https://github.com/${review.repoFullName}/runs/${review.gateCheckRunId}`}
                rel="noopener"
                className="text-rust hover:underline"
              >
                view on GitHub
              </a>
            ) : (
              "Not recorded"
            )}
          </RunFact>
          <RunFact label="Tokens">
            {envelope
              ? `${envelope.usage.promptTokens.toLocaleString()} input / ${envelope.usage.completionTokens.toLocaleString()} output`
              : "Not recorded"}
          </RunFact>
        </dl>

        {review.errorMessage && (
          <div className="card mt-6 border-rust p-5">
            <p className="eyebrow text-rust">Run error</p>
            <p className="mt-2 whitespace-pre-wrap font-mono text-xs">{review.errorMessage}</p>
          </div>
        )}

        <RunLogPane />

        {summary && (
          <section className="mt-8">
            <p className="eyebrow">Summary</p>
            <div className="card mt-3 p-5 text-sm text-ink-soft">
              <FindingMarkdown>{summary}</FindingMarkdown>
            </div>
          </section>
        )}

        {envelope && (
          <>
            <section className="mt-8">
              <p className="eyebrow">
                Findings ({findings.length}) · {envelope.counts.suppressed} suppressed below
                threshold · {envelope.counts.ungrounded} dropped ungrounded
              </p>
              <div className="card mt-3 divide-y divide-stone/60">
                {findings.slice(0, MAX_RENDERED_FINDINGS).map((finding, index) => (
                  <FindingCard
                    key={`${finding.path}:${finding.line}:${index}`}
                    finding={finding}
                    repoFullName={review.repoFullName}
                    headSha={review.headSha}
                    reviewUrl={reviewUrl}
                  />
                ))}
                {findings.length > MAX_RENDERED_FINDINGS && (
                  <p className="px-5 py-4 text-center text-sm text-charcoal/50">
                    {findings.length - MAX_RENDERED_FINDINGS} more findings not shown
                  </p>
                )}
                {findings.length === 0 && (
                  <p className="px-5 py-8 text-center text-sm text-charcoal/50">
                    No findings shipped on this review.
                  </p>
                )}
              </div>
            </section>

            {resolved.length > 0 && (
              <section className="mt-8">
                <p className="eyebrow">Resolved since the previous review ({resolved.length})</p>
                <div className="card mt-3 divide-y divide-stone/60 opacity-70">
                  {resolved.slice(0, MAX_RENDERED_FINDINGS).map((finding, index) => (
                    <FindingCard
                      key={`${finding.path}:${finding.line}:${index}`}
                      finding={finding}
                      repoFullName={review.repoFullName}
                      headSha={review.headSha}
                      reviewUrl={reviewUrl}
                    />
                  ))}
                  {resolved.length > MAX_RENDERED_FINDINGS && (
                    <p className="px-5 py-4 text-center text-sm text-charcoal/50">
                      {resolved.length - MAX_RENDERED_FINDINGS} more findings not shown
                    </p>
                  )}
                </div>
              </section>
            )}
          </>
        )}

        {usageEvents.length > 0 && (
          <section className="mt-8">
            <p className="eyebrow">Usage events</p>
            <div className="card mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone text-left font-mono text-xs text-charcoal/50">
                    <th className="px-4 py-3 font-normal">model</th>
                    <th className="px-4 py-3 font-normal">input tokens</th>
                    <th className="px-4 py-3 font-normal">output tokens</th>
                    <th className="px-4 py-3 font-normal">total tokens</th>
                    <th className="px-4 py-3 font-normal">recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {usageEvents.map((event) => (
                    <tr key={event.id} className="border-b border-stone/60 last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {event.modelUsed ?? "Not recorded"}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {event.promptTokens.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {event.completionTokens.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {(event.promptTokens + event.completionTokens).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {formatTimestamp(event.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {estimatedCost !== null && (
                <p className="border-t border-stone px-4 py-3 font-mono text-xs text-charcoal/70">
                  Estimated cost (BYOK):{" "}
                  <span className="font-medium text-charcoal">
                    {formatEstimatedCost(estimatedCost)}
                  </span>
                </p>
              )}
            </div>
          </section>
        )}

        {envelopeInvalid && (
          <p className="card mt-8 p-8 text-center text-sm text-charcoal/50">
            The stored envelope does not match the current envelope contract and cannot be
            displayed.
          </p>
        )}

        {!envelope && !envelopeInvalid && !review.errorMessage && (
          <p className="card mt-8 p-8 text-center text-sm text-charcoal/50">
            {review.status === "stale"
              ? "Superseded by a later push to the pull request; this review never completed."
              : "No envelope stored yet; the review has not completed."}
          </p>
        )}
      </main>
    </LiveRunProvider>
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
