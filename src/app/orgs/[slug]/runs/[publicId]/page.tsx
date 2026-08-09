import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import {
  FindingConfidenceDetails,
  FindingConfidenceLabel,
} from "@/components/finding-confidence";
import { MODELS } from "@/data/models";
import { schema } from "@/lib/db";
import {
  envelopeSchema,
  hasLegacyCombinedModelUsage,
  LEGACY_COMBINED_USAGE_NOTICE,
  type Finding,
  type SuppressionReason,
} from "@/lib/envelope";
import {
  getReviewApprovalState,
  type FindingApprovalState,
  type ReviewForApproval,
} from "@/lib/finding-approvals";
import { sortFindingsForDisplay } from "@/lib/findings";
import { githubFindingLocationUrl, githubPrUrl } from "@/lib/github-links";
import type { ConfigProvenanceEntry } from "@/lib/github/contents";
import { requireOrgMembership } from "@/lib/org-access";
import {
  isHostedReviewUnavailable,
  reviewDisplayStatus,
} from "@/lib/review-outcome";
import {
  normalizeReviewTriggerContext,
  reviewTriggerLabel,
  type ReviewTriggerSource,
} from "@/lib/review-trigger";
import type { PublicationState } from "@/lib/publication-receipt";

import {
  approveFinding,
  revokeFinding,
} from "../../actions";
import { DismissFindingForm } from "./dismiss-finding-form";
import { RevokeDismissalForm } from "./revoke-dismissal-form";
import {
  LiveDuration,
  LiveFinishedAt,
  LiveGateStatus,
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

function configSourceLabel(entry: ConfigProvenanceEntry): string {
  if (entry.source === "repository") return "repository";
  if (entry.source === "shared") return "owner .github";
  if (entry.source === "organization") return "form fallback";
  return "built-in";
}

function configFallbackLabel(entry: ConfigProvenanceEntry): string | null {
  if (!entry.fallback) return null;
  const source = entry.fallback.repository ?? "owner .github";
  const state = entry.fallback.status === "transient"
    ? "temporarily unavailable"
    : "unavailable";
  return `${source} ${state}; ${configSourceLabel(entry)} used`;
}

function RunFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border-l border-stone/70 pl-3">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-charcoal/70">
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

function findingKindLabel(kind: Finding["kind"]): string {
  return kind === "humanEscalation" ? "Maintainer decision needed" : kind;
}

const SUPPRESSION_REASON_LABELS: Record<SuppressionReason, string> = {
  ignored: "Ignored by repository policy",
  belowSeverity: "Below the configured severity threshold",
  belowConfidence: "Below the configured confidence threshold",
  maxFindings: "Beyond the configured finding limit",
  nonActionable: "No concrete action identified",
  anchorMismatch: "Cited a line its named construct does not sit on",
  duplicateRootCause: "Restates a published finding about another location",
  derivedFromSuppressed: "Built on a finding suppressed as mis-anchored",
};

const PUBLICATION_STATE_LABELS: Record<PublicationState, string> = {
  inline: "inline",
  checkAnnotation: "check annotation",
  summaryOnly: "summary",
  carried: "carried",
  resolved: "resolved",
  suppressed: "suppressed",
  inlineRejected: "summary (inline unavailable)",
  outdated: "outdated",
  deleted: "deleted",
  unknown: "not recorded",
};

function FindingCard({
  finding,
  repoFullName,
  headSha,
  reviewUrl,
  publicationState,
}: {
  finding: Finding;
  repoFullName: string;
  headSha: string;
  reviewUrl: string;
  publicationState?: PublicationState;
}) {
  const location = `${finding.path}:${finding.line}${
    finding.endLine && finding.endLine > finding.line ? `-${finding.endLine}` : ""
  }`;
  const locationUrl = githubFindingLocationUrl(
    repoFullName,
    headSha,
    finding.path,
    finding.line,
    finding.endLine,
  );
  return (
    <article className="px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${SEVERITY_STYLES[finding.severity]}`}
        >
          severity: {finding.severity}
        </span>
        <span className="font-mono text-[11px] text-charcoal/70">
          {findingKindLabel(finding.kind)}
        </span>
        <FindingConfidenceLabel finding={finding} />
        {publicationState && (
          <span className="font-mono text-[10px] text-charcoal/70">
            publication: {PUBLICATION_STATE_LABELS[publicationState]}
          </span>
        )}
        {locationUrl ? (
          <a
            href={locationUrl}
            rel="noopener"
            className="font-mono text-[11px] text-rust hover:underline"
          >
            {location}
          </a>
        ) : (
          <span className="font-mono text-[11px] text-charcoal/70">{location}</span>
        )}
      </div>
      <h2 className="mt-3 text-base font-semibold leading-snug">
        <a href={reviewUrl} rel="noopener" className="hover:text-rust hover:underline">
          {finding.title}
        </a>
      </h2>
      <div className="mt-2 text-sm leading-relaxed text-ink-soft">
        <FindingMarkdown>{finding.body}</FindingMarkdown>
      </div>
      <FindingConfidenceDetails finding={finding} />
    </article>
  );
}

function ApprovalStatusBadge({ state }: { state: FindingApprovalState }) {
  const label = state.activeDismissal
    ? "Dismissed"
    : state.activeApproval
    ? "Decision recorded"
    : state.latestDismissal?.revokedAt || state.latestApproval?.revokedAt
      ? "Decision revoked"
      : "Needs maintainer decision";
  const classes = state.activeDismissal || state.activeApproval
    ? "border-brand-secondary/40 bg-brand-secondary/10 text-[#166657]"
    : state.latestDismissal?.revokedAt || state.latestApproval?.revokedAt
      ? "border-charcoal/20 bg-stone/40 text-charcoal/70"
      : "border-rust/35 bg-rust/5 text-rust";
  return (
    <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${classes}`}>
      {label}
    </span>
  );
}

function ApprovalPanel({
  slug,
  publicId,
  headSha,
  states,
  approvableFindingIds,
  isAdmin,
}: {
  slug: string;
  publicId: string;
  headSha: string;
  states: FindingApprovalState[];
  approvableFindingIds: ReadonlySet<string>;
  isAdmin: boolean;
}) {
  if (states.length === 0) return null;
  const hasPendingDecision = states.some((state) => state.blocking);
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">
            {hasPendingDecision ? "Maintainer decision needed" : "Maintainer decisions"}
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {hasPendingDecision
              ? "Encode the intended behavior in code, tests, configuration, or the pull request, then push again. For an irreducible finding, an organization admin can record a commit-scoped dismissal with a required classification and rationale."
              : "These findings have recorded maintainer decisions."}{" "}
            Decisions apply only to commit{" "}
            <span className="font-mono text-charcoal">{headSha.slice(0, 12)}</span>.
          </p>
        </div>
      </div>
      <div className="card mt-3 divide-y divide-stone/60">
        {states.map((state) => {
          const latestDecision = [state.latestDismissal, state.latestApproval]
            .filter((decision): decision is NonNullable<typeof decision> => decision !== null)
            .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
          const approval = state.activeDismissal ?? state.activeApproval ?? latestDecision;
          return (
            <article key={state.findingId} className="px-5 py-5 sm:px-6">
              <div className="flex flex-wrap items-center gap-3">
                <ApprovalStatusBadge state={state} />
                <span className="font-mono text-[11px] text-charcoal/70">
                  {findingKindLabel(state.finding.kind)}
                </span>
                <span className="font-mono text-[11px] text-charcoal/70">
                  {state.findingId.slice(0, 16)}
                </span>
                {state.severityBlocking && (
                  <span className="font-mono text-[11px] text-rust">
                    also severity-blocking
                  </span>
                )}
              </div>
              <h2 className="mt-3 text-base font-semibold leading-snug">{state.finding.title}</h2>
              <p className="mt-2 font-mono text-[11px] text-charcoal/70">
                {state.finding.path}:{state.finding.line}
              </p>
              <div className="mt-2 text-sm leading-relaxed text-ink-soft">
                <FindingMarkdown>{state.finding.body}</FindingMarkdown>
              </div>
              {!state.activeDismissal && !state.latestDismissal?.revokedAt && !state.activeApproval && !state.latestApproval?.revokedAt && (
                <p className="mt-3 rounded-card border border-stone/70 bg-stone/20 px-3 py-2 text-xs text-charcoal/75">
                  {isAdmin
                    ? "Fix or encode the intended behavior and push again. Use dismissal to document a false positive, an accepted risk, or work owned outside this commit."
                    : "Fix or encode the intended behavior and push again. An organization admin can record a dismissal only for a genuine exception to this commit's gate."}
                </p>
              )}
              {approval && (
                <dl className="mt-3 grid gap-2 text-xs text-charcoal/70 sm:grid-cols-2">
                  <div>
                    <dt className="font-mono uppercase tracking-wide text-charcoal/70">Actor</dt>
                    <dd>@{approval.actorLoginSnapshot}</dd>
                  </div>
                  <div>
                    <dt className="font-mono uppercase tracking-wide text-charcoal/70">Source</dt>
                    <dd>{approval.source}</dd>
                  </div>
                  {approval.verb === "dismiss" && (
                    <div>
                      <dt className="font-mono uppercase tracking-wide text-charcoal/70">Reason</dt>
                      <dd>{approval.reasonTag}</dd>
                    </div>
                  )}
                  {approval.authorSelfDismissal && (
                    <div>
                      <dt className="font-mono uppercase tracking-wide text-charcoal/70">Author action</dt>
                      <dd>Pull request author dismissed this finding</dd>
                    </div>
                  )}
                  <div>
                    <dt className="font-mono uppercase tracking-wide text-charcoal/70">Recorded</dt>
                    <dd>{formatTimestamp(approval.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="font-mono uppercase tracking-wide text-charcoal/70">Head SHA</dt>
                    <dd className="font-mono">{headSha.slice(0, 12)}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="font-mono uppercase tracking-wide text-charcoal/70">Rationale</dt>
                    <dd className="mt-1 whitespace-pre-wrap">{approval.rationale}</dd>
                  </div>
                </dl>
              )}
              {isAdmin && !state.activeDismissal && !state.activeApproval && (
                <details name={`finding-decision-${state.findingId}`} className="mt-4 rounded-card border border-stone/70 px-3 py-2 text-sm">
                  <summary className="cursor-pointer font-medium text-charcoal/75">Dismiss this finding</summary>
                  <p className="mt-2 font-mono text-xs text-charcoal/70">
                    @postil dismiss {state.findingId} -- false-positive: rationale
                  </p>
                  <DismissFindingForm
                    slug={slug}
                    publicId={publicId}
                    findingId={state.findingId}
                  />
                </details>
              )}
              {isAdmin && approvableFindingIds.has(state.findingId) && !state.activeApproval && !state.activeDismissal && !state.latestApproval?.revokedAt && !state.severityBlocking && (
                <details name={`finding-decision-${state.findingId}`} className="mt-4 rounded-card border border-stone/70 px-3 py-2 text-sm">
                  <summary className="cursor-pointer font-medium text-charcoal/75">
                    Record a commit-scoped override
                  </summary>
                  <form action={approveFinding} className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="publicId" value={publicId} />
                    <input type="hidden" name="findingId" value={state.findingId} />
                    <label className="grid gap-1 text-xs font-medium text-charcoal/75">
                      Rationale
                    <textarea
                      name="rationale"
                      required
                      minLength={1}
                      rows={2}
                      className="min-h-16 rounded-md border border-stone bg-ivory px-3 py-2 text-sm text-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rust"
                      placeholder="Why no code or configuration change can resolve this decision"
                    />
                    </label>
                    <button className="rounded-md bg-charcoal px-4 py-2 text-sm font-semibold text-ivory hover:bg-rust">
                      Record override
                    </button>
                  </form>
                </details>
              )}
              {isAdmin && state.activeApproval && (
                <form action={revokeFinding} className="mt-4">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="publicId" value={publicId} />
                  <input type="hidden" name="findingId" value={state.findingId} />
                  <button className="rounded-md border border-rust/40 px-4 py-2 text-sm font-semibold text-rust hover:bg-rust/5">
                    Withdraw override
                  </button>
                </form>
              )}
              {isAdmin && state.activeDismissal && (
                <RevokeDismissalForm
                  slug={slug}
                  publicId={publicId}
                  findingId={state.findingId}
                />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ slug: string; publicId: string }>;
}) {
  const { slug, publicId } = await params;
  if (!UUID_PATTERN.test(publicId)) notFound();

  const { db, org, membership } = await requireOrgMembership(slug);

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
        configProvenance: schema.reviews.configProvenance,
        engineGateFailing: schema.reviews.engineGateFailing,
        gateFailing: schema.reviews.gateFailing,
        errorMessage: schema.reviews.errorMessage,
        advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
        gateCheckRunId: schema.reviews.gateCheckRunId,
        queuedAt: schema.reviews.queuedAt,
        startedAt: schema.reviews.startedAt,
        finishedAt: schema.reviews.finishedAt,
        triggerSource: schema.reviews.triggerSource,
        triggerContext: schema.reviews.triggerContext,
        repositoryId: schema.reviews.repositoryId,
        repoFullName: schema.repositories.fullName,
        orgId: schema.installations.orgId,
        githubInstallationId: schema.installations.githubInstallationId,
        githubRepoId: schema.repositories.githubRepoId,
        installationAccountType: schema.installations.accountType,
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
  if (!review || review.orgId === null) notFound();

  const [usageEvents, byokSettings, gateSyncJobs, publicationRows, publicationReceiptRows] = await Promise.all([
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
    db
      .select({ id: schema.jobs.id, status: schema.jobs.status })
      .from(schema.jobs)
      .where(and(
        eq(schema.jobs.kind, "gate-state-sync"),
        sql`${schema.jobs.payload}->>'reviewId' = ${String(review.id)}`,
      ))
      .orderBy(desc(schema.jobs.id))
      .limit(1),
    db
      .select({
        findingId: schema.findingPublications.findingId,
        currentState: schema.findingPublications.currentState,
      })
      .from(schema.findingPublications)
      .where(eq(schema.findingPublications.reviewId, review.id)),
    db
      .select({ receiptVersion: schema.reviewPublicationReceipts.receiptVersion })
      .from(schema.reviewPublicationReceipts)
      .where(eq(schema.reviewPublicationReceipts.reviewId, review.id))
      .limit(1),
  ]);
  const usesByok = byokSettings.length > 0;

  // The jsonb column's type is a compile-time cast; re-validate before deep
  // rendering so a legacy or malformed envelope degrades to a notice instead
  // of throwing mid-render.
  const parsedEnvelope = review.envelope ? envelopeSchema.safeParse(review.envelope) : null;
  const envelope = parsedEnvelope?.success ? parsedEnvelope.data : null;
  const reviewForApproval: ReviewForApproval = {
    id: review.id,
    publicId: review.publicId,
    repositoryId: review.repositoryId,
    prNumber: review.prNumber,
    headSha: review.headSha,
    status: review.status,
    envelope,
    engineGateFailing: review.engineGateFailing,
    gateFailing: review.gateFailing,
    gateCheckRunId: review.gateCheckRunId,
    repoFullName: review.repoFullName,
    orgId: review.orgId,
    githubInstallationId: review.githubInstallationId,
    githubRepoId: review.githubRepoId,
    installationAccountType: review.installationAccountType,
  };
  const approvalState = envelope ? await getReviewApprovalState(db, reviewForApproval) : null;
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
  const configProvenance = review.configProvenance?.entries ?? [];
  const displayStatus = reviewDisplayStatus(review.status, review.errorMessage);
  const hostedReviewUnavailable = isHostedReviewUnavailable(
    review.status,
    review.errorMessage,
  );
  const triggerSource = review.triggerSource as ReviewTriggerSource;
  const triggerContext = normalizeReviewTriggerContext(review.triggerContext);
  const publicationByFindingId = new Map(
    publicationRows.map((row) => [row.findingId, row.currentState as PublicationState]),
  );
  const publicationCounts = publicationRows.reduce<Record<PublicationState, number>>(
    (counts, row) => {
      const state = row.currentState as PublicationState;
      counts[state] += 1;
      return counts;
    },
    {
      inline: 0,
      checkAnnotation: 0,
      summaryOnly: 0,
      carried: 0,
      resolved: 0,
      suppressed: 0,
      inlineRejected: 0,
      outdated: 0,
      deleted: 0,
      unknown: 0,
    },
  );
  const publishedFindingCount =
    publicationCounts.inline +
    publicationCounts.checkAnnotation +
    publicationCounts.summaryOnly +
    publicationCounts.carried +
    publicationCounts.inlineRejected;
  const publicationObserved = [1, 2].includes(
    publicationReceiptRows[0]?.receiptVersion ?? 0,
  );

  return (
    <LiveRunProvider
      slug={org.slug}
      publicId={review.publicId}
      initialStatus={displayStatus}
      queuedAt={review.queuedAt.toISOString()}
      startedAt={review.startedAt?.toISOString() ?? null}
      initialFinishedAt={review.finishedAt?.toISOString() ?? null}
      recordedDurationMs={envelope?.durationMs ?? null}
      initialGateFailing={review.gateFailing}
      initialGateSyncStatus={gateSyncJobs[0]?.status ?? null}
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
          <LiveReviewStatus />
          <LiveGateStatus />
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
          <RunFact label="Trigger">
            {triggerContext?.source === "requested_review" && triggerContext.sourceUrl ? (
              <a
                href={triggerContext.sourceUrl}
                rel="noopener"
                className="text-rust hover:underline"
              >
                {reviewTriggerLabel(triggerSource)}
                {triggerContext.requestedByLogin
                  ? ` by @${triggerContext.requestedByLogin}`
                  : ""}
              </a>
            ) : (
              reviewTriggerLabel(triggerSource)
            )}
          </RunFact>
          <RunFact label="Model">{envelope?.modelUsed ?? "Not recorded"}</RunFact>
          {(envelope?.scorerModel || envelope?.scorerError) && (
            <RunFact label="Independent check">
              {envelope.scorerModel ?? "Unavailable; reviewer confidence retained"}
              {envelope.scorerModel && envelope.scorerDisagreements !== undefined
                ? ` · ${envelope.scorerDisagreements} disagreement${envelope.scorerDisagreements === 1 ? "" : "s"}`
                : ""}
            </RunFact>
          )}
          <RunFact label="Status">
            <LiveReviewStatus />
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
          <div className={`card mt-6 p-5 ${hostedReviewUnavailable ? "" : "border-rust"}`}>
            <p className={`eyebrow ${hostedReviewUnavailable ? "" : "text-rust"}`}>
              {hostedReviewUnavailable ? "Review unavailable" : "Run error"}
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              {hostedReviewUnavailable
                ? `This hosted review did not run because managed reviews were paused. The GitHub checks were neutral.${usesByok ? "" : " An organization admin can use BYOK in Settings for future reviews."}`
                : review.errorMessage}
            </p>
          </div>
        )}

        <RunLogPane />

        {configProvenance.length > 0 && (
          <details className="card mt-6 overflow-hidden">
            <summary className="cursor-pointer px-5 py-4 font-mono text-xs uppercase tracking-wide text-charcoal/70">
              Configuration sources
              {review.configProvenance?.degraded ? " · degraded" : ""}
            </summary>
            <div className="divide-y divide-stone/60 border-t border-stone/60">
              {configProvenance.map((entry) => (
                <div
                  key={entry.slot}
                  className="grid gap-1 px-5 py-3 text-xs sm:grid-cols-[9rem_9rem_1fr]"
                >
                  <span className="font-mono text-charcoal/70">{entry.slot}</span>
                  <span>{configSourceLabel(entry)}</span>
                  <span className="break-all font-mono text-charcoal/70">
                    {entry.repository ? `${entry.repository}${entry.commitSha ? `@${entry.commitSha.slice(0, 12)}` : ""}:` : ""}
                    {entry.path ?? "default"}
                    {entry.stale ? " · last known good" : ""}
                    {entry.status && entry.status !== "present" ? ` · ${entry.status}` : ""}
                    {configFallbackLabel(entry) ? ` · ${configFallbackLabel(entry)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}

        {summary && (
          <section className="mt-8">
            <p className="eyebrow">Summary</p>
            <div className="card mt-3 p-5 text-sm text-ink-soft">
              <FindingMarkdown>{summary}</FindingMarkdown>
            </div>
          </section>
        )}

        {approvalState && (
          <ApprovalPanel
            slug={org.slug}
            publicId={review.publicId}
            headSha={review.headSha}
            states={approvalState.dismissalFindingStates}
            approvableFindingIds={new Set(
              approvalState.findingStates.map((state) => state.findingId),
            )}
            isAdmin={membership.role === "admin"}
          />
        )}

        {envelope && (
          <>
            <section className="mt-8">
              <p className="eyebrow">
                {!publicationObserved || publicationCounts.unknown > 0
                  ? "Publication not recorded"
                  : `Published findings (${publishedFindingCount})`} · {publicationCounts.suppressed} suppressed by policy ·{" "}
                {envelope.counts.ungrounded} dropped ungrounded
              </p>
              <div className="card mt-3 divide-y divide-stone/60">
                {findings.slice(0, MAX_RENDERED_FINDINGS).map((finding, index) => (
                  <FindingCard
                    key={`${finding.path}:${finding.line}:${index}`}
                    finding={finding}
                    repoFullName={review.repoFullName}
                    headSha={review.headSha}
                    reviewUrl={reviewUrl}
                    publicationState={finding.id ? (publicationByFindingId.get(finding.id) ?? "unknown") : "unknown"}
                  />
                ))}
                {findings.length > MAX_RENDERED_FINDINGS && (
                  <p className="px-5 py-4 text-center text-sm text-charcoal/70">
                    {findings.length - MAX_RENDERED_FINDINGS} more findings not shown
                  </p>
                )}
                {findings.length === 0 && (
                  <p className="px-5 py-8 text-center text-sm text-charcoal/70">
                    No findings shipped on this review.
                  </p>
                )}
              </div>
            </section>

            {envelope.counts.suppressed > 0 && (
              <details className="card mt-8 overflow-hidden">
                <summary className="cursor-pointer px-5 py-4 font-mono text-xs uppercase tracking-wide text-charcoal/70 sm:px-6">
                  Suppressed findings ({envelope.counts.suppressed})
                </summary>
                {envelope.suppressedFindings?.length ? (
                  <div className="divide-y divide-stone/60 border-t border-stone/60">
                    {envelope.suppressedFindings
                      .slice(0, MAX_RENDERED_FINDINGS)
                      .map((entry, index) => (
                        <div key={`${entry.finding.path}:${entry.finding.line}:${index}`}>
                          <p className="bg-stone/20 px-5 py-2 font-mono text-[10px] uppercase tracking-wide text-charcoal/70 sm:px-6">
                            {SUPPRESSION_REASON_LABELS[entry.reason]}
                          </p>
                          <FindingCard
                            finding={entry.finding}
                            repoFullName={review.repoFullName}
                            headSha={review.headSha}
                            reviewUrl={reviewUrl}
                            publicationState={entry.finding.id ? (publicationByFindingId.get(entry.finding.id) ?? "unknown") : "unknown"}
                          />
                        </div>
                      ))}
                    {envelope.suppressedFindings.length > MAX_RENDERED_FINDINGS && (
                      <p className="border-t border-stone/60 px-5 py-4 text-center text-sm text-charcoal/70">
                        {envelope.suppressedFindings.length - MAX_RENDERED_FINDINGS} more suppressed findings not shown
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="border-t border-stone/60 px-5 py-4 text-sm text-charcoal/70 sm:px-6">
                    This review predates retained suppression details. Only the count is available.
                  </p>
                )}
              </details>
            )}

            {resolved.length > 0 && (
              <section className="mt-8">
                <p className="eyebrow">Resolved since the previous review ({resolved.length})</p>
                <div className="card mt-3 divide-y divide-stone/60">
                  {resolved.slice(0, MAX_RENDERED_FINDINGS).map((finding, index) => (
                    <FindingCard
                      key={`${finding.path}:${finding.line}:${index}`}
                      finding={finding}
                      repoFullName={review.repoFullName}
                      headSha={review.headSha}
                      reviewUrl={reviewUrl}
                      publicationState={finding.id ? (publicationByFindingId.get(finding.id) ?? "unknown") : "unknown"}
                    />
                  ))}
                  {resolved.length > MAX_RENDERED_FINDINGS && (
                    <p className="px-5 py-4 text-center text-sm text-charcoal/70">
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
                  <tr className="border-b border-stone text-left font-mono text-xs text-charcoal/70">
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
              {envelope && hasLegacyCombinedModelUsage(envelope) && (
                <p className="border-t border-stone px-4 py-3 text-xs text-charcoal/70">
                  {LEGACY_COMBINED_USAGE_NOTICE}
                </p>
              )}
            </div>
          </section>
        )}

        {envelopeInvalid && (
          <p className="card mt-8 p-8 text-center text-sm text-charcoal/70">
            The stored envelope does not match the current envelope contract and cannot be
            displayed.
          </p>
        )}

        {!envelope && !envelopeInvalid && !review.errorMessage && (
          <p className="card mt-8 p-8 text-center text-sm text-charcoal/70">
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
