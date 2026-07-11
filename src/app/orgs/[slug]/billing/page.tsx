import type { Metadata } from "next";
import Link from "next/link";

import { asc, desc, eq } from "drizzle-orm";

import {
  calculateBillingCreditBalance,
  formatCurrencyCents,
} from "@/lib/billing-credits";
import {
  calculateBillingUsage,
  currentMonthBillingPeriod,
  formatDateTime,
  formatRepoDays,
  type RepositoryEnablementAction,
} from "@/lib/billing-usage";
import { schema } from "@/lib/db";
import { requireOrgMembership } from "@/lib/org-access";

export const metadata: Metadata = {
  title: "Organization billing",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function OrgBillingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { db, org, membership } = await requireOrgMembership(slug);
  if (membership.role !== "admin") {
    throw new Error("this page requires an organization admin");
  }

  const [eventRows, currentRepoRows, creditGrantRows, usageRows] = await Promise.all([
    db
      .select({
        id: schema.repositoryEnablementEvents.id,
        repositoryId: schema.repositoryEnablementEvents.repositoryId,
        githubRepoId: schema.repositoryEnablementEvents.githubRepoId,
        repositoryFullName: schema.repositoryEnablementEvents.repositoryFullName,
        repositoryPrivate: schema.repositoryEnablementEvents.repositoryPrivate,
        action: schema.repositoryEnablementEvents.action,
        source: schema.repositoryEnablementEvents.source,
        occurredAt: schema.repositoryEnablementEvents.occurredAt,
      })
      .from(schema.repositoryEnablementEvents)
      .where(eq(schema.repositoryEnablementEvents.orgId, org.id))
      .orderBy(
        asc(schema.repositoryEnablementEvents.occurredAt),
        asc(schema.repositoryEnablementEvents.id),
      ),
    db
      .select({
        id: schema.repositories.id,
        fullName: schema.repositories.fullName,
        private: schema.repositories.private,
      })
      .from(schema.repositories)
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(eq(schema.installations.orgId, org.id)),
    db
      .select({
        id: schema.billingCreditGrants.id,
        amountCents: schema.billingCreditGrants.amountCents,
        reason: schema.billingCreditGrants.reason,
        actor: schema.billingCreditGrants.actor,
        source: schema.billingCreditGrants.source,
        idempotencyKey: schema.billingCreditGrants.idempotencyKey,
        appliesAt: schema.billingCreditGrants.appliesAt,
        createdAt: schema.billingCreditGrants.createdAt,
      })
      .from(schema.billingCreditGrants)
      .where(eq(schema.billingCreditGrants.orgId, org.id))
      .orderBy(
        desc(schema.billingCreditGrants.createdAt),
        desc(schema.billingCreditGrants.id),
      ),
    db
      .select({
        id: schema.usageEvents.id,
        promptTokens: schema.usageEvents.promptTokens,
        completionTokens: schema.usageEvents.completionTokens,
        modelUsed: schema.usageEvents.modelUsed,
        createdAt: schema.usageEvents.createdAt,
      })
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.orgId, org.id))
      .orderBy(asc(schema.usageEvents.createdAt), asc(schema.usageEvents.id)),
  ]);
  const currentRepoById = new Map(currentRepoRows.map((repo) => [repo.id, repo]));

  const billingEvents = eventRows
    .filter((event) => isEnablementAction(event.action))
    .map((event) => ({
      ...event,
      action: event.action as RepositoryEnablementAction,
    }));
  const usage = calculateBillingUsage(billingEvents, currentMonthBillingPeriod());
  const historyRows = [...eventRows].sort((a, b) => {
    const time = b.occurredAt.getTime() - a.occurredAt.getTime();
    return time === 0 ? b.id - a.id : time;
  });
  const currentEnabledRepositories = usage.currentEnabledRepositories.map((repo) => {
    const current = repo.repositoryId === null ? undefined : currentRepoById.get(repo.repositoryId);
    return {
      ...repo,
      repositoryFullName: current?.fullName ?? repo.repositoryFullName,
      repositoryPrivate: current?.private ?? repo.repositoryPrivate,
    };
  });
  const enabledPublicCount = currentEnabledRepositories.filter(
    (repo) => !repo.repositoryPrivate,
  ).length;
  const enabledPrivateCount = currentEnabledRepositories.filter(
    (repo) => repo.repositoryPrivate,
  ).length;
  const creditBalance = calculateBillingCreditBalance(creditGrantRows, usageRows);

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">
            <Link href={`/orgs/${org.slug}`} className="hover:underline">
              {org.slug}
            </Link>{" "}
            / billing
          </p>
          <h1 className="serif-display mt-2 text-3xl">{org.name} billing</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/orgs/${org.slug}/settings`} className="btn-secondary text-xs">
            Settings
          </Link>
          <Link href={`/orgs/${org.slug}`} className="btn-secondary text-xs">
            Back to dashboard
          </Link>
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-4">
        <div className="card p-6">
          <p className="eyebrow">Current period</p>
          <p className="serif-display mt-3 text-5xl">
            {formatRepoDays(usage.totalRepoDays)}
          </p>
          <p className="mt-2 text-sm text-charcoal/70">enabled repo-days</p>
          <p className="mt-4 font-mono text-[11px] text-charcoal/55">
            {formatDateTime(usage.period.start)} to {formatDateTime(usage.period.end)}
          </p>
        </div>
        <div className="card p-6">
          <p className="eyebrow">Enabled repositories</p>
          <p className="serif-display mt-3 text-5xl">
            {currentEnabledRepositories.length}
          </p>
          <p className="mt-2 text-sm text-charcoal/70">billing-active now</p>
          <div className="mt-4 grid grid-cols-2 gap-3 font-mono text-xs">
            <div className="rounded-card border border-stone px-3 py-2">
              <p className="text-charcoal/55">public</p>
              <p className="mt-1 text-lg text-charcoal">{enabledPublicCount}</p>
            </div>
            <div className="rounded-card border border-stone px-3 py-2">
              <p className="text-charcoal/55">private</p>
              <p className="mt-1 text-lg text-charcoal">{enabledPrivateCount}</p>
            </div>
          </div>
        </div>
        <div className="card p-6">
          <p className="eyebrow">Credit balance</p>
          <p className="serif-display mt-3 text-5xl">
            {formatCurrencyCents(creditBalance.remainingCents)}
          </p>
          <p className="mt-2 text-sm text-charcoal/70">
            remaining from {formatCurrencyCents(creditBalance.totalGrantedCents)} granted
          </p>
          <p className="mt-4 font-mono text-[11px] text-charcoal/55">
            {formatCurrencyCents(creditBalance.usageCostCents)} charged across{" "}
            {creditBalance.chargedUsageEvents.toLocaleString()} usage events
          </p>
        </div>
        <div className="card p-6">
          <p className="eyebrow">Ledger events</p>
          <p className="serif-display mt-3 text-5xl">{eventRows.length}</p>
          <p className="mt-2 text-sm text-charcoal/70">append-only enablement records</p>
          <p className="mt-4 text-xs text-charcoal/55">
            Each event stores repository identity and visibility at the time it
            was recorded.
          </p>
        </div>
      </div>

      <div className="mt-10">
        <p className="eyebrow">Credit grants</p>
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone/70 font-mono text-[11px] uppercase tracking-[0.12em] text-charcoal/55">
              <tr>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Key</th>
                <th className="px-4 py-3">Applies from</th>
                <th className="px-4 py-3">Recorded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone/60">
              {creditGrantRows.map((grant) => (
                <tr key={grant.id}>
                  <td className="px-4 py-3 font-mono text-xs">
                    {formatCurrencyCents(grant.amountCents)}
                  </td>
                  <td className="px-4 py-3 text-sm">{grant.reason}</td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {grant.actor} / {grant.source}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {grant.idempotencyKey}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {formatDateTime(grant.appliesAt)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {formatDateTime(grant.createdAt)}
                  </td>
                </tr>
              ))}
              {creditGrantRows.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-charcoal/50" colSpan={6}>
                    No credits have been granted for this organization.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {creditBalance.unpricedUsageEvents > 0 && (
            <p className="border-t border-stone px-4 py-3 font-mono text-xs text-rust">
              {creditBalance.unpricedUsageEvents.toLocaleString()} usage events have no priced model
              and are excluded from credit charges.
            </p>
          )}
        </div>
      </div>

      <div className="mt-10">
        <p className="eyebrow">Currently enabled</p>
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone/70 font-mono text-[11px] uppercase tracking-[0.12em] text-charcoal/55">
              <tr>
                <th className="px-4 py-3">Repository</th>
                <th className="px-4 py-3">Visibility</th>
                <th className="px-4 py-3">Enabled since</th>
                <th className="px-4 py-3 text-right">Period repo-days</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone/60">
              {currentEnabledRepositories.map((repo) => (
                <tr key={repo.repositoryKey}>
                  <td className="px-4 py-3 font-mono text-xs">{repo.repositoryFullName}</td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {repo.repositoryPrivate ? "private" : "public"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {formatDateTime(repo.enabledSince)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatRepoDays(repo.enabledMsInPeriod / (24 * 60 * 60 * 1000))}
                  </td>
                </tr>
              ))}
              {currentEnabledRepositories.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-charcoal/50" colSpan={4}>
                    No repositories are enabled from the billing ledger.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-10">
        <p className="eyebrow">Repository period detail</p>
        <div className="card mt-3 divide-y divide-stone/60">
          {usage.repositoryDetails.map((repo) => (
            <div key={repo.repositoryKey} className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto]">
              <div>
                <p className="font-mono text-sm">{repo.repositoryFullName}</p>
                <p className="font-mono text-[11px] text-charcoal/60">
                  {repo.repositoryPrivate ? "private" : "public"} · GitHub repo{" "}
                  {repo.githubRepoId}
                </p>
              </div>
              <p className="font-mono text-sm">
                {formatRepoDays(repo.enabledMsInPeriod / (24 * 60 * 60 * 1000))} repo-days
              </p>
            </div>
          ))}
          {usage.repositoryDetails.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-charcoal/50">
              No billing events have been recorded for this organization.
            </p>
          )}
        </div>
      </div>

      <div className="mt-10">
        <p className="eyebrow">Enablement history</p>
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone/70 font-mono text-[11px] uppercase tracking-[0.12em] text-charcoal/55">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Repository</th>
                <th className="px-4 py-3">Visibility</th>
                <th className="px-4 py-3">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone/60">
              {historyRows.map((event) => (
                <tr key={event.id}>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {formatDateTime(event.occurredAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        event.action === "enable"
                          ? "rounded-full border border-gate px-2.5 py-0.5 font-mono text-[11px] text-gate"
                          : "rounded-full border border-rust px-2.5 py-0.5 font-mono text-[11px] text-rust"
                      }
                    >
                      {event.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {event.repositoryFullName}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {event.repositoryPrivate ? "private" : "public"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {event.source}
                  </td>
                </tr>
              ))}
              {historyRows.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-charcoal/50" colSpan={5}>
                    No enablement events have been recorded.
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

function isEnablementAction(action: string): action is RepositoryEnablementAction {
  return action === "enable" || action === "disable";
}
