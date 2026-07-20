import type { Metadata } from "next";
import Link from "next/link";

import { and, asc, eq, gte, lt, sql } from "drizzle-orm";

import {
  calculateBillingUsage,
  currentMonthBillingPeriod,
  formatDateTime,
  type RepositoryEnablementAction,
} from "@/lib/billing-usage";
import { schema } from "@/lib/db";
import { requireOrgMembership } from "@/lib/org-access";
import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
} from "@/lib/pricing-policy";
import {
  canProcessPrivateRepository,
  requireMatchingProviderMode,
} from "@/lib/private-repository-entitlement";
import { paddleCheckoutConfiguration } from "@/lib/paddle-billing";
import { BillingContactForm } from "./billing-contact-form";
import { NotificationPreferencesForm } from "./notification-preferences-form";
import {
  BillingCheckoutButton,
  BillingPortalButton,
} from "./billing-checkout-button";

export const metadata: Metadata = {
  title: "Organization billing",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function OrgBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ contactVerification?: string; checkout?: string }>;
}) {
  const { slug } = await params;
  const { contactVerification, checkout } = await searchParams;
  const { db, org, membership } = await requireOrgMembership(slug);
  if (membership.role !== "admin") {
    throw new Error("this page requires an organization admin");
  }

  const [eventRows, currentRepoRows] = await Promise.all([
    db
      .select({
        id: schema.repositoryEnablementEvents.id,
        repositoryId: schema.repositoryEnablementEvents.repositoryId,
        githubRepoId: schema.repositoryEnablementEvents.githubRepoId,
        repositoryFullName:
          schema.repositoryEnablementEvents.repositoryFullName,
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
  ]);
  const currentRepoById = new Map(
    currentRepoRows.map((repo) => [repo.id, repo]),
  );

  const billingEvents = eventRows
    .filter((event) => isEnablementAction(event.action))
    .map((event) => ({
      ...event,
      action: event.action as RepositoryEnablementAction,
    }));
  const usage = calculateBillingUsage(
    billingEvents,
    currentMonthBillingPeriod(),
  );
  const currentEnabledRepositories = usage.currentEnabledRepositories.map(
    (repo) => {
      const current =
        repo.repositoryId === null
          ? undefined
          : currentRepoById.get(repo.repositoryId);
      return {
        ...repo,
        repositoryFullName: current?.fullName ?? repo.repositoryFullName,
        repositoryPrivate: current?.private ?? repo.repositoryPrivate,
      };
    },
  );
  const enabledPublicCount = currentEnabledRepositories.filter(
    (repo) => !repo.repositoryPrivate,
  ).length;
  const enabledPrivateCount = currentEnabledRepositories.filter(
    (repo) => repo.repositoryPrivate,
  ).length;
  const rawPrivateAccess = await canProcessPrivateRepository(db, {
    orgId: org.id,
    repositoryPrivate: true,
  });
  const providerSettings = (
    await db
      .select({
        hasKey: sql<boolean>`${schema.orgSettings.apiKeyCiphertext} IS NOT NULL`,
      })
      .from(schema.orgSettings)
      .where(eq(schema.orgSettings.orgId, org.id))
      .limit(1)
  )[0];
  const privateAccess = requireMatchingProviderMode(
    rawPrivateAccess,
    providerSettings?.hasKey ?? false,
  );
  const entitlement = privateAccess.entitlement;
  const providerSubscription = (
    await db
      .select({
        status: schema.billingProviderSubscriptions.status,
        currentPeriodEndsAt:
          schema.billingProviderSubscriptions.currentPeriodEndsAt,
      })
      .from(schema.billingProviderSubscriptions)
      .where(eq(schema.billingProviderSubscriptions.orgId, org.id))
      .limit(1)
  )[0];
  const checkoutAvailable = Boolean(paddleCheckoutConfiguration());
  const activeTrial =
    privateAccess.reason === "active_trial" && entitlement?.trialEndsAt;
  const contactState = entitlement
    ? (
        await db
          .select({
            activeEmail: schema.organizationEntitlements.billingContactEmail,
            pendingEmail: schema.organizationEntitlements.billingContactPending,
            verifiedAt:
              schema.organizationEntitlements.billingContactVerifiedAt,
          })
          .from(schema.organizationEntitlements)
          .where(eq(schema.organizationEntitlements.orgId, org.id))
          .limit(1)
      )[0]
    : undefined;
  const notificationPreferences = (
    await db
      .select({
        billingSummaryEmail:
          schema.organizationNotificationPreferences.billingSummaryEmail,
        serviceSummaryEmail:
          schema.organizationNotificationPreferences.serviceSummaryEmail,
      })
      .from(schema.organizationNotificationPreferences)
      .where(eq(schema.organizationNotificationPreferences.orgId, org.id))
      .limit(1)
  )[0];
  const hasEntitlementPeriod = Boolean(
    entitlement?.periodStartsAt && entitlement.periodEndsAt,
  );
  const authorPeriodStart = hasEntitlementPeriod
    ? entitlement!.periodStartsAt!
    : usage.period.start;
  const authorPeriodEnd = hasEntitlementPeriod
    ? entitlement!.periodEndsAt!
    : usage.period.end;
  const activePrivateAuthorCount =
    (
      await db
        .select({
          count: sql<number>`COUNT(DISTINCT ${schema.reviews.authorGithubId})::int`,
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
        .where(
          and(
            eq(schema.installations.orgId, org.id),
            eq(schema.repositories.private, true),
            gte(schema.reviews.queuedAt, authorPeriodStart),
            lt(schema.reviews.queuedAt, authorPeriodEnd),
          ),
        )
    )[0]?.count ?? 0;

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
          <Link
            href={`/orgs/${org.slug}/settings/audit`}
            className="btn-secondary text-xs"
          >
            Audit log
          </Link>
          <Link
            href={`/orgs/${org.slug}/settings`}
            className="btn-secondary text-xs"
          >
            Settings
          </Link>
          <Link href={`/orgs/${org.slug}`} className="btn-secondary text-xs">
            Back to dashboard
          </Link>
        </div>
      </div>

      {contactVerification === "success" && (
        <p
          role="status"
          className="mt-6 rounded-card border border-gate/40 bg-gate/5 px-4 py-3 text-sm text-gate"
        >
          Billing contact verified.
        </p>
      )}
      {contactVerification === "invalid" && (
        <p
          role="alert"
          className="mt-6 rounded-card border border-rust/40 bg-rust/5 px-4 py-3 text-sm text-rust"
        >
          This billing contact verification link is invalid or expired.
        </p>
      )}
      {checkout === "submitted" && (
        <p
          role="status"
          className="mt-6 rounded-card border border-gate/40 bg-gate/5 px-4 py-3 text-sm text-gate"
        >
          Payment method submitted. Access updates after the verified billing
          event arrives.
        </p>
      )}

      <div
        className={`card mt-8 p-6 ${privateAccess.allowed ? "border-gate" : "border-rust"}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Private repository access</p>
            <p className="mt-2 text-lg font-medium">
              {activeTrial
                ? "Free trial active"
                : privateAccess.allowed
                  ? "Private access ready"
                  : entitlement
                    ? "Private access paused"
                    : "Public only"}
            </p>
            <p
              className="mt-1 max-w-2xl text-sm text-ink-soft"
              data-trial-state={
                activeTrial
                  ? "active"
                  : entitlement?.status === "past_due"
                    ? "ended"
                    : undefined
              }
            >
              {activeTrial ? (
                <>
                  No card is required. Private reviews are included through{" "}
                  <time dateTime={activeTrial.toISOString()}>
                    {formatDateTime(activeTrial)}
                  </time>
                  , then pause unless a paid plan is active.
                </>
              ) : privateAccess.allowed ? (
                `${entitlement?.subscriptionMode === "byok" ? "BYOK" : "Hosted"} private-repository reviews are enabled.`
              ) : entitlement ? (
                entitlement.status === "past_due" && entitlement.trialEndsAt ? (
                  <>
                    The trial ended{" "}
                    <time dateTime={entitlement.trialEndsAt.toISOString()}>
                      {formatDateTime(entitlement.trialEndsAt)}
                    </time>
                    . Private reviews are paused until a paid plan is active.
                  </>
                ) : (
                  "Check the plan status and provider setup below."
                )
              ) : (
                "Add a private plan before Postil reviews or responds in private repositories. Public reviews remain free."
              )}
            </p>
          </div>
          <span className="rounded-full border border-stone px-3 py-1 font-mono text-[11px] text-charcoal/70">
            {entitlement
              ? `${entitlement.subscriptionMode} · ${entitlement.status}`
              : "public · free"}
          </span>
        </div>
        {entitlement && (
          <div className="mt-4 grid gap-3 font-mono text-xs sm:grid-cols-2">
            <p>
              billing contact: {entitlement.billingContactEmail ?? "not set"}
              {entitlement.billingContactEmail && (
                <span className="ml-1 text-charcoal/55">
                  (
                  {entitlement.billingContactVerifiedAt
                    ? "verified"
                    : "unverified"}
                  )
                </span>
              )}
            </p>
            <p>private PR authors: {activePrivateAuthorCount}</p>
          </div>
        )}
        {!entitlement && (
          <Link
            className="btn-primary mt-4 inline-flex text-xs"
            href="/install"
          >
            Start 30-day trial
          </Link>
        )}
        {entitlement?.subscriptionMode === "byok" &&
          (!providerSubscription ||
            providerSubscription.status === "canceled") &&
          checkoutAvailable && <BillingCheckoutButton slug={org.slug} />}
        {providerSubscription && (
          <>
            <p className="mt-4 text-xs text-charcoal/60">
              Billing subscription: {providerSubscription.status}
              {providerSubscription.currentPeriodEndsAt && (
                <>
                  {" "}
                  · period ends{" "}
                  {formatDateTime(providerSubscription.currentPeriodEndsAt)}
                </>
              )}
            </p>
            {checkoutAvailable && <BillingPortalButton slug={org.slug} />}
          </>
        )}
        {entitlement?.subscriptionMode === "hosted" && (
          <p className="mt-4 border-t border-stone/60 pt-4 text-xs text-charcoal/60">
            Model access is included in the hosted plan price.
          </p>
        )}
        {entitlement?.subscriptionMode === "byok" && (
          <p className="mt-4 border-t border-stone/60 pt-4 text-xs text-charcoal/60">
            Provider usage is billed directly to your provider account.
            Configure budgets, alerts, and hard limits there.
          </p>
        )}
        {entitlement && (
          <>
            <BillingContactForm
              slug={org.slug}
              activeEmail={contactState?.activeEmail ?? null}
              pendingEmail={contactState?.pendingEmail ?? null}
              verified={Boolean(contactState?.verifiedAt)}
            />
            <NotificationPreferencesForm
              key={`${notificationPreferences?.billingSummaryEmail ?? true}:${
                notificationPreferences?.serviceSummaryEmail ?? true
              }`}
              slug={org.slug}
              billingSummaryEmail={
                notificationPreferences?.billingSummaryEmail ?? true
              }
              serviceSummaryEmail={
                notificationPreferences?.serviceSummaryEmail ?? true
              }
            />
          </>
        )}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <div className="card p-6">
          <p className="eyebrow">Plan</p>
          <p className="serif-display mt-3 text-3xl">
            {activeTrial
              ? "$0"
              : entitlement
                ? `$${
                    entitlement.subscriptionMode === "byok"
                      ? BYOK_ACTIVE_AUTHOR_MONTHLY_USD
                      : HOSTED_ACTIVE_AUTHOR_MONTHLY_USD
                  }`
                : "$0"}
          </p>
          <p className="mt-2 text-sm text-charcoal/70">
            {activeTrial
              ? `through ${formatDateTime(activeTrial)}`
              : entitlement
                ? "per billed private-PR author"
                : "for public repositories"}
          </p>
          <p className="mt-4 font-mono text-[11px] text-charcoal/55">
            Public repositories are free. Repositories are not billing units.
          </p>
        </div>
        <div className="card p-6">
          <p className="eyebrow">Private authors</p>
          <p className="serif-display mt-3 text-5xl">
            {activePrivateAuthorCount}
          </p>
          <p className="mt-2 text-sm text-charcoal/70">
            reviewed on private PRs this period
          </p>
          <p className="mt-4 font-mono text-[11px] text-charcoal/55">
            Human and automation identities each count when their private PR is
            reviewed.
          </p>
        </div>
        <div className="card p-6">
          <p className="eyebrow">Repository coverage</p>
          <p className="serif-display mt-3 text-5xl">
            {currentEnabledRepositories.length}
          </p>
          <p className="mt-2 text-sm text-charcoal/70">
            enabled, with no per-repo fee
          </p>
          <p className="mt-4 font-mono text-[11px] text-charcoal/55">
            {enabledPublicCount} public · {enabledPrivateCount} private
          </p>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-stone/60">
              {currentEnabledRepositories.map((repo) => (
                <tr key={repo.repositoryKey}>
                  <td className="px-4 py-3 font-mono text-xs">
                    {repo.repositoryFullName}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {repo.repositoryPrivate ? "private" : "public"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                    {formatDateTime(repo.enabledSince)}
                  </td>
                </tr>
              ))}
              {currentEnabledRepositories.length === 0 && (
                <tr>
                  <td
                    className="px-4 py-8 text-center text-sm text-charcoal/50"
                    colSpan={3}
                  >
                    No repositories are enabled.
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

function isEnablementAction(
  action: string,
): action is RepositoryEnablementAction {
  return action === "enable" || action === "disable";
}
