import type { Metadata } from "next";
import Link from "next/link";

import { and, desc, eq, sql } from "drizzle-orm";

import { getPool, schema } from "@/lib/db";
import { PrivateBillingNotice } from "@/components/private-billing-notice";
import { StatusIcon } from "@/components/status-icon";
import { hostedInferenceAvailable as managedHostedInferenceAvailable } from "@/lib/env";
import { getRepoConfigProbes } from "@/lib/github/config-probe";
import { requireOrgMembership } from "@/lib/org-access";
import {
  canProcessPrivateRepository,
  requireMatchingProviderMode,
} from "@/lib/private-repository-entitlement";
import { deriveRepoHealth, getRepoHealthRows, type RepoHealth } from "@/lib/repo-health";
import { formatRelativeTime } from "@/lib/time";
import {
  buildGateEnforcementDryRunPlan,
  deriveGateEnforcementPresentation,
} from "@/lib/gate-enforcement-health";
import {
  isVisibleConfigArtifact,
  ownerConfigRepositoryFullName,
  resolveConfigArtifacts,
  sharedConfigFilesAvailableToReviews,
  type VisibleConfigArtifact,
} from "../config-resolution";
import { ConfigRecheckButton } from "../config-recheck-button";
import { GateEnforcementRecheckButton } from "../gate-enforcement-recheck-button";
import { RepoHealthBanner } from "../repo-health-banner";
import { RepositoryAccessCheck } from "../repository-access-check";
import { SettingsForm } from "../settings-form";

export const metadata: Metadata = {
  title: "Organization settings",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { db, org, membership } = await requireOrgMembership(slug);
  const now = new Date();
  if (membership.role !== "admin") {
    throw new Error("this page requires an organization admin");
  }

  const settings = (
    await db
      .select({
        apiBase: schema.orgSettings.apiBase,
        apiFormat: schema.orgSettings.apiFormat,
        model: schema.orgSettings.model,
        modelCascade: schema.orgSettings.modelCascade,
        configYaml: schema.orgSettings.configYaml,
        guardrailsMd: schema.orgSettings.guardrailsMd,
        contentPolicyMd: schema.orgSettings.contentPolicyMd,
        sharedConfigEnabled: schema.orgSettings.sharedConfigEnabled,
        gateEnabled: schema.orgSettings.gateEnabled,
        hasKey: sql<boolean>`${schema.orgSettings.apiKeyCiphertext} IS NOT NULL`,
        hasAdditionalAuth: sql<boolean>`${schema.orgSettings.apiAuthHeaderCiphertext} IS NOT NULL AND ${schema.orgSettings.apiAuthValueCiphertext} IS NOT NULL`,
      })
      .from(schema.orgSettings)
      .where(eq(schema.orgSettings.orgId, org.id))
      .limit(1)
  )[0];
  const hostedInferenceAvailable = await managedHostedInferenceAvailable(getPool());
  const managedReviewsPaused = !hostedInferenceAvailable && !(settings?.hasKey ?? false);
  const sharedSnapshot = (
    await db
      .select({
        sourceFullName: schema.orgConfigSnapshots.sourceFullName,
        visibility: schema.orgConfigSnapshots.visibility,
        defaultBranch: schema.orgConfigSnapshots.defaultBranch,
        commitSha: schema.orgConfigSnapshots.commitSha,
        files: schema.orgConfigSnapshots.files,
        stale: schema.orgConfigSnapshots.stale,
        lastError: schema.orgConfigSnapshots.lastError,
      })
      .from(schema.orgConfigSnapshots)
      .where(eq(schema.orgConfigSnapshots.orgId, org.id))
      .limit(1)
  )[0];
  const entitlement = (
    await db
      .select({
        subscriptionMode: schema.organizationEntitlements.subscriptionMode,
        status: schema.organizationEntitlements.status,
        trialEndsAt: schema.organizationEntitlements.trialEndsAt,
      })
      .from(schema.organizationEntitlements)
      .where(eq(schema.organizationEntitlements.orgId, org.id))
      .limit(1)
  )[0];
  const installationAccount = (
    await db
      .select({ accountLogin: schema.installations.accountLogin })
      .from(schema.installations)
      .where(eq(schema.installations.orgId, org.id))
      .orderBy(schema.installations.id)
      .limit(1)
  )[0];

  const repos = await db
    .select({
      id: schema.repositories.id,
      fullName: schema.repositories.fullName,
      enabled: schema.repositories.enabled,
      private: schema.repositories.private,
      githubInstallationId: schema.installations.githubInstallationId,
      accountLogin: schema.installations.accountLogin,
      gateEnforcementStatus: schema.repositoryGateEnforcement.status,
      gateDefaultBranch: schema.repositoryGateEnforcement.defaultBranch,
      gateBranchProtection: schema.repositoryGateEnforcement.branchProtection,
      gateEvidence: schema.repositoryGateEnforcement.evidence,
      gateCheckedAt: schema.repositoryGateEnforcement.checkedAt,
      gateLastSuccessfulAt: schema.repositoryGateEnforcement.lastSuccessfulAt,
      gateLastError: schema.repositoryGateEnforcement.lastError,
    })
    .from(schema.repositories)
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .leftJoin(
      schema.repositoryGateEnforcement,
      eq(schema.repositoryGateEnforcement.repositoryId, schema.repositories.id),
    )
    .where(eq(schema.installations.orgId, org.id))
    .orderBy(schema.repositories.fullName);

  const enabledRepos = repos
    .filter((repo) => repo.enabled)
    .map((repo) => ({
      repositoryId: repo.id,
      githubInstallationId: repo.githubInstallationId,
      fullName: repo.fullName,
    }));
  const [probes, repoHealthRows] = await Promise.all([
    getRepoConfigProbes(db, enabledRepos, { now }),
    getRepoHealthRows(db, org.id),
  ]);
  const probeByRepositoryId = new Map(
    probes.map((probe) => [probe.repositoryId, probe]),
  );
  const liveConfigFilesByRepositoryId = new Map(
    probes
      .filter((probe) => probe.ok)
      .map((probe) => [probe.repositoryId, probe.files]),
  );
  const healthByRepositoryId = new Map(
    repoHealthRows.map((row) => [row.repositoryId, row]),
  );
  const liveOrgConfigFiles = [
    settings?.configYaml ? "org:.postil.yaml" : null,
    settings?.guardrailsMd ? "org:.postil/guardrails.md" : null,
    settings?.contentPolicyMd ? "org:.postil/content-policy.md" : null,
  ].filter((file): file is string => file !== null);
  const sharedSourceFullName = ownerConfigRepositoryFullName(
    installationAccount?.accountLogin ?? org.slug,
  );
  const sharedSourceInstalled = repos.some(
    (repo) => repo.fullName.toLowerCase() === sharedSourceFullName.toLowerCase(),
  );
  const liveSharedConfigFiles = sharedConfigFilesAvailableToReviews(
    sharedSnapshot?.files,
    settings?.sharedConfigEnabled !== false,
    sharedSourceInstalled,
  );

  const latestRepoReviews = await db
    .selectDistinctOn([schema.reviews.repositoryId], {
      repositoryId: schema.reviews.repositoryId,
      configFiles: schema.reviews.configFiles,
      finishedAt: schema.reviews.finishedAt,
    })
    .from(schema.reviews)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(and(eq(schema.installations.orgId, org.id), eq(schema.reviews.status, "completed")))
    .orderBy(
      schema.reviews.repositoryId,
      desc(schema.reviews.finishedAt),
      desc(schema.reviews.id),
    );
  const latestRepoReviewByRepositoryId = new Map(
    latestRepoReviews.map((review) => [review.repositoryId, review]),
  );
  const repoConfigSummaries = repos
    .filter((repo) => repo.enabled)
    .map((repo) => {
      const latestReview = latestRepoReviewByRepositoryId.get(repo.id);
      const probe = probeByRepositoryId.get(repo.id) ?? { ok: false, files: [] };
      const artifacts = resolveConfigArtifacts(
        latestReview?.configFiles,
        probe,
        liveOrgConfigFiles,
        liveSharedConfigFiles,
      ).filter(isVisibleConfigArtifact);
      const healthRow = healthByRepositoryId.get(repo.id);
      const health = healthRow
        ? deriveRepoHealth(healthRow, now, managedReviewsPaused)
        : null;
      return { repo, latestReview, artifacts, healthRow, health };
    })
    .filter((summary) => summary.artifacts.length > 0);
  const showConfigFiles =
    repos.length === 0 || repoConfigSummaries.length > 0 || enabledRepos.length > 0;
  const rawPrivateAccess = repos.some((repo) => repo.private && repo.enabled)
    ? await canProcessPrivateRepository(db, {
        orgId: org.id,
        repositoryPrivate: true,
      })
    : null;
  const privateAccess = rawPrivateAccess
    ? requireMatchingProviderMode(rawPrivateAccess, settings?.hasKey ?? false)
    : null;
  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">
            <Link href={`/orgs/${org.slug}`} className="hover:underline">
              {org.slug}
            </Link>{" "}
            / settings
          </p>
          <h1 className="serif-display mt-2 text-3xl">{org.name} settings</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/orgs/${org.slug}/settings/audit`} className="btn-secondary text-xs">
            Audit log
          </Link>
          <Link href={`/orgs/${org.slug}/billing`} className="btn-secondary text-xs">
            Billing
          </Link>
          <Link href={`/orgs/${org.slug}`} className="btn-secondary text-xs">
            Back to dashboard
          </Link>
        </div>
      </div>

      <PrivateBillingNotice orgSlug={org.slug} decision={privateAccess} />

      <RepoHealthBanner
        slug={org.slug}
        rows={repoHealthRows}
        now={now}
        managedReviewsPaused={managedReviewsPaused}
        liveConfigFilesByRepositoryId={liveConfigFilesByRepositoryId}
      />

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
        <div>
          <p className="eyebrow">Organization settings</p>
          <SettingsForm
            slug={org.slug}
            settings={settings}
            managedReviewsPaused={managedReviewsPaused}
            hostedInferenceAvailable={hostedInferenceAvailable}
            trialCanSwitchProvider={Boolean(
              entitlement?.status === "trialing" &&
                entitlement.trialEndsAt &&
                entitlement.trialEndsAt > now,
            )}
            sharedSnapshot={sharedSnapshot}
            sharedSourceFullName={sharedSnapshot?.sourceFullName ?? sharedSourceFullName}
            sharedSourceInstalled={sharedSourceInstalled}
            billedMode={
              entitlement?.subscriptionMode === "hosted" ||
              entitlement?.subscriptionMode === "byok"
                ? entitlement.subscriptionMode
                : null
            }
          />
        </div>

        <div>
          <RepositoryAccessCheck slug={org.slug} />
        </div>
        {showConfigFiles && (
          <div className="mt-8">
            {enabledRepos.length > 0 && (
              <GateEnforcementCoverage
                slug={org.slug}
                repositories={repos.filter((repo) => repo.enabled)}
                now={now}
                gateEnabled={settings?.gateEnabled ?? false}
              />
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="eyebrow">Config files</p>
              {enabledRepos.length > 0 && (
                <ConfigRecheckButton slug={org.slug} />
              )}
            </div>
            {(repoConfigSummaries.length > 0 || repos.length === 0) && (
              <div className="card mt-3 divide-y divide-stone/60">
                {repoConfigSummaries.map(
                  ({ repo, latestReview, artifacts, healthRow, health }) => {
                    return (
                      <div key={repo.id} className="space-y-3 px-4 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <a
                              href={`https://github.com/${repo.fullName}`}
                              className="font-mono text-sm hover:underline"
                              rel="noopener noreferrer"
                            >
                              {repo.fullName}
                            </a>
                            <RepoHealthLine
                              enabled={repo.enabled}
                              health={health}
                              lastEnabledAt={healthRow?.lastEnabledAt ?? null}
                              lastCompletedAt={
                                healthRow?.lastCompletedAt ?? latestReview?.finishedAt ?? null
                              }
                              now={now}
                            />
                          </div>
                        </div>
                        <div className="grid gap-2">
                          {artifacts.map((artifact) => {
                            const artifactHref = configArtifactHref(
                              artifact,
                              repo.fullName,
                              sharedSnapshot?.sourceFullName ?? sharedSourceFullName,
                            );
                            return (
                              <div
                                key={artifact.key}
                                className="grid gap-2 rounded-card border border-stone/70 px-3 py-2 sm:grid-cols-[1fr_auto]"
                              >
                                <div>
                                  {artifactHref ? (
                                    <a
                                      href={artifactHref}
                                      className="font-mono text-[11px] text-charcoal underline decoration-stone hover:decoration-charcoal"
                                      rel="noopener noreferrer"
                                    >
                                      {artifact.label}
                                    </a>
                                  ) : (
                                    <p className="font-mono text-[11px] text-charcoal">
                                      {artifact.label}
                                    </p>
                                  )}
                                  <p className="mt-0.5 text-xs text-charcoal/60">
                                    {configArtifactDescription(artifact)}
                                  </p>
                                </div>
                                {artifact.state !== "active" && (
                                  <span
                                    className={`flex h-fit shrink-0 items-center gap-1.5 font-mono text-[11px] ${
                                      artifact.state === "removed"
                                        ? "text-rust"
                                        : artifact.state === "pending"
                                          ? "text-charcoal/70"
                                          : "text-charcoal/55"
                                    }`}
                                  >
                                    <StatusIcon
                                      kind={artifact.state === "removed"
                                        ? "warn"
                                        : artifact.state === "pending"
                                          ? "info"
                                          : "unknown"}
                                      size={13}
                                    />
                                    {artifact.state}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  },
                )}
                {repos.length === 0 && (
                  <p className="px-4 py-8 text-center text-sm text-charcoal/50">
                    No repositories. Install the GitHub App on this organization.
                  </p>
                )}
              </div>
            )}
            {repoConfigSummaries.length > 0 && (
              <p className="mt-3 text-xs text-charcoal/60">
                Config is read from each repository&apos;s default branch. Root config
                discovery accepts <code>.postil.yaml</code>, <code>.postil.yml</code>,
                or <code>.postil.json</code>; hosted organization fallback writes
                <code>.postil.yaml</code>. Guardrails and content policy fall back
                independently.
              </p>
            )}
          </div>
        )}
      </div>

      <p className="mt-12 border-t border-stone/60 pt-4 text-xs text-charcoal/60">
        The <Link href="/docs" className="text-rust hover:underline">documentation</Link>{" "}
        covers setup, configuration, and the merge gate. For anything unclear, email{" "}
        <a href="mailto:hello@postil.dev" className="text-rust hover:underline">
          hello@postil.dev
        </a>
        .
      </p>
    </div>
  );
}

function GateEnforcementCoverage({
  slug,
  repositories,
  now,
  gateEnabled,
}: {
  slug: string;
  gateEnabled: boolean;
  repositories: Array<{
    id: number;
    fullName: string;
    gateEnforcementStatus: string | null;
    gateDefaultBranch: string | null;
    gateBranchProtection: string | null;
    gateEvidence: {
      branchProtection: {
        exactMatch: boolean;
        match?: "exact_app" | "any_source" | "foreign_app" | "unknown_identity" | "none";
      };
      protectionApi?: {
        status?: "ok" | "forbidden" | "not_protected" | "error";
        exactMatch?: boolean;
        match?: "exact_app" | "any_source" | "foreign_app" | "unknown_identity" | "none";
      } | null;
      activeRules: {
        exactMatch: boolean;
        match?: "exact_app" | "any_source" | "foreign_app" | "unknown_identity" | "none";
      };
    } | null;
    gateCheckedAt: Date | null;
    gateLastSuccessfulAt: Date | null;
    gateLastError: string | null;
  }>;
  now: Date;
}) {
  const rows = repositories.map((repository) => ({
    repository,
    presentation: deriveGateEnforcementPresentation(
      {
        status: repository.gateEnforcementStatus,
        checkedAt: repository.gateCheckedAt,
        lastError: repository.gateLastError,
      },
      now,
    ),
  }));
  const enforcementCounts = rows.reduce(
    (counts, row) => {
      counts[row.presentation.status] += 1;
      return counts;
    },
    { required: 0, not_required: 0, unknown: 0 },
  );
  // Action-needed states first, then unknowns, then verified rows.
  const statusRank = { not_required: 0, unknown: 1, required: 2 } as const;
  const sortedRows = [...rows].sort(
    (a, b) =>
      statusRank[a.presentation.status] - statusRank[b.presentation.status] ||
      a.repository.fullName.localeCompare(b.repository.fullName),
  );
  const statusTone = (status: "required" | "not_required" | "unknown") =>
    status === "required"
      ? "text-gate"
      : status === "not_required"
        ? gateEnabled
          ? "text-rust"
          : "text-charcoal/70"
        : "text-charcoal/55";
  const statusKind = (status: "required" | "not_required" | "unknown") =>
    status === "required"
      ? ("pass" as const)
      : status === "not_required"
        ? gateEnabled
          ? ("warn" as const)
          : ("info" as const)
        : ("unknown" as const);
  const countEntries = [
    { status: "not_required" as const, count: enforcementCounts.not_required, label: "not enforced" },
    { status: "unknown" as const, count: enforcementCounts.unknown, label: "unverified" },
    { status: "required" as const, count: enforcementCounts.required, label: "enforced" },
  ].filter((entry) => entry.count > 0);
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">Installation health</p>
        <GateEnforcementRecheckButton slug={slug} />
      </div>
      <div className="mt-3 rounded-card border border-stone/70 bg-paper px-4 py-3">
        {!gateEnabled && (
          <p className="mb-2 text-xs text-charcoal/65">
            The merge gate is off for this organization, so <code>postil/gate</code>{" "}
            reports without blocking regardless of findings. These statuses matter
            once the gate is on.
          </p>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {countEntries.map((entry) => (
            <span
              key={entry.status}
              className={`flex items-center gap-1.5 font-mono text-[11px] ${statusTone(entry.status)}`}
            >
              <StatusIcon kind={statusKind(entry.status)} size={13} />
              {entry.count} {entry.label}
            </span>
          ))}
        </div>
      </div>
      <div className="card mt-3 divide-y divide-stone/60">
        {sortedRows.map(({ repository, presentation }) => {
          const plan = buildGateEnforcementDryRunPlan(
            presentation,
            repository.gateDefaultBranch,
          );
          const evidence = repository.gateEvidence;
          const matches = [
            evidence?.branchProtection.match,
            evidence?.protectionApi?.match,
            evidence?.activeRules.match,
          ];
          const anySource = matches.includes("any_source");
          const identityUnknown = matches.includes("unknown_identity");
          const foreignSource = matches.includes("foreign_app");
          const protectionForbidden = evidence?.protectionApi?.status === "forbidden";
          const detail = presentation.status === "required" &&
              (evidence?.branchProtection.exactMatch || evidence?.protectionApi?.exactMatch)
            ? "branch protection requires the check from the Postil App"
            : presentation.status === "required" && evidence?.activeRules.exactMatch
              ? "an active ruleset requires the check from the Postil App"
            : anySource
              ? "a required check named postil/gate exists, but any app may satisfy it"
              : foreignSource
                ? "postil/gate is required from a different app, not Postil"
                : identityUnknown
                  ? "branch protection requires a check named postil/gate without saying which app must post it"
                  : repository.gateBranchProtection === "unprotected"
                    ? "the default branch has no branch protection or ruleset"
                    : repository.gateBranchProtection === "protected"
                      ? "branch rules exist but do not require postil/gate"
                      : "branch rules could not be read";
          const settingsHref = `https://github.com/${repository.fullName}/settings/rules`;
          return (
            <div key={repository.id} className="px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <a
                    href={`https://github.com/${repository.fullName}`}
                    className="block truncate font-mono text-sm hover:underline"
                    rel="noopener noreferrer"
                  >
                    {repository.fullName}
                  </a>
                  <p className="mt-0.5 font-mono text-[11px] text-charcoal/55">
                    {repository.gateDefaultBranch
                      ? `default: ${repository.gateDefaultBranch}`
                      : "default branch unavailable"}
                    {repository.gateCheckedAt
                      ? ` · checked ${relative(repository.gateCheckedAt, now)}`
                      : " · not checked"}
                  </p>
                </div>
                <span
                  className={`flex shrink-0 items-center gap-1.5 font-mono text-[11px] ${statusTone(presentation.status)} ${
                    presentation.status === "not_required" && gateEnabled ? "font-medium" : ""
                  }`}
                >
                  <StatusIcon kind={statusKind(presentation.status)} size={13} />
                  {presentation.enforcementLabel}
                </span>
              </div>
              {presentation.status !== "required" && (
                <p className="mt-2 text-xs text-charcoal/70">{presentation.consequence}</p>
              )}
              {presentation.status === "not_required" && gateEnabled && (
                <a
                  href={settingsHref}
                  className="mt-1 inline-block text-xs text-rust underline"
                  rel="noopener noreferrer"
                >
                  Open repository rules
                </a>
              )}
              {presentation.status === "unknown" && (
                <p className="mt-1 text-xs text-charcoal/55">
                  {presentation.stale
                    ? "Re-check to refresh this status."
                    : identityUnknown && protectionForbidden
                      ? "A ruleset naming the Postil App verifies without extra access. Granting the App's optional repository Administration (read-only) permission verifies classic protection too."
                      : "Re-check, or open the panel below for what Postil could not read."}
                </p>
              )}
              {repository.gateLastError && (
                <p className="mt-1 text-xs text-rust">
                  {repository.gateLastError}
                  {repository.gateLastSuccessfulAt
                    ? ` Last confirmed ${relative(repository.gateLastSuccessfulAt, now)}.`
                    : ""}
                </p>
              )}
              <details className="mt-3 rounded-card border border-stone/60 px-3 py-2 text-xs text-charcoal/65">
                <summary className="cursor-pointer font-medium text-charcoal">
                  {plan.action === "none"
                    ? "Verified rule"
                    : plan.action === "inspect"
                      ? "How to verify"
                      : "How to enforce"}
                </summary>
                <div className="mt-3 space-y-2">
                  <p><strong>Evidence:</strong> {detail}.</p>
                  {identityUnknown && (
                    <p>
                      Classic branch protection does not tell Postil which app a
                      required check is bound to unless the App&apos;s optional
                      repository Administration (read-only) permission is granted. A branch
                      ruleset that requires <code>postil/gate</code> from the Postil
                      App is verifiable without extra access: recreate the
                      requirement there and remove it from classic protection.
                    </p>
                  )}
                  <p><strong>Target:</strong> {plan.target}</p>
                  <p><strong>Rule:</strong> {plan.desiredRule}</p>
                  <p><strong>Effect:</strong> {plan.impact}</p>
                  <p><strong>Risk:</strong> {plan.risk}</p>
                  <p><strong>Rollback:</strong> {plan.rollback}</p>
                  <p>No changes are applied from this page.</p>
                  <a
                    href={settingsHref}
                    className="inline-block text-rust underline"
                    rel="noopener noreferrer"
                  >
                    Open repository rules
                  </a>
                </div>
              </details>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-charcoal/60">
        Enforced means GitHub names <code>postil/gate</code> and binds it to the Postil
        App. Missing identities and unreadable rules stay unverified. See the{" "}
        <Link href="/docs/gate" className="text-rust hover:underline">gate guide</Link>,
        or email{" "}
        <a href="mailto:hello@postil.dev" className="text-rust hover:underline">
          hello@postil.dev
        </a>{" "}
        for help with rollout.
      </p>
    </section>
  );
}

function RepoHealthLine({
  enabled,
  health,
  lastEnabledAt,
  lastCompletedAt,
  now,
}: {
  enabled: boolean;
  health: RepoHealth | null;
  lastEnabledAt: Date | null;
  lastCompletedAt: Date | null;
  now: Date;
}) {
  if (!enabled) {
    return <p className="font-mono text-[11px] text-charcoal/55">disabled</p>;
  }
  if (health === "awaiting-first-pr" && lastEnabledAt) {
    return (
      <div>
        <p className="font-mono text-[11px] text-charcoal/55">
          enabled {relative(lastEnabledAt, now)} · no reviews yet
        </p>
        <p className="mt-1 text-xs text-charcoal/60">
          No reviews yet. The first review runs when a pull request is opened or updated.
        </p>
      </div>
    );
  }
  if (health === "paused") {
    return (
      <p className="font-mono text-[11px] text-charcoal/55">
        enabled · managed reviews paused
      </p>
    );
  }
  if (health === "awaiting-review") {
    return (
      <p className="font-mono text-[11px] text-charcoal/55">
        enabled · awaiting the next review
      </p>
    );
  }
  if (health === "never-reviewed" && lastEnabledAt) {
    return (
      <p className="font-mono text-[11px] text-rust">
        enabled {relative(lastEnabledAt, now)} · never reviewed · see warning above
      </p>
    );
  }
  if (health === "failing") {
    return (
      <p className="font-mono text-[11px] text-rust">
        enabled · reviews failing · see warning above
      </p>
    );
  }
  if (lastCompletedAt) {
    return (
      <p className="font-mono text-[11px] text-charcoal/55">
        enabled · last review {relative(lastCompletedAt, now)}
      </p>
    );
  }
  return <p className="font-mono text-[11px] text-charcoal/55">enabled</p>;
}

function relative(value: Date, now: Date): string {
  return formatRelativeTime(value.toISOString(), now.getTime());
}

/**
 * Link a config artifact to its file on GitHub. Only live repository and
 * shared files link; organization fallbacks are edited in the form on this
 * page, and removed or unverified paths may no longer exist on HEAD.
 */
function configArtifactHref(
  artifact: VisibleConfigArtifact,
  repoFullName: string,
  sharedSourceFullName: string,
): string | null {
  if (!artifact.file || (artifact.state !== "active" && artifact.state !== "pending")) {
    return null;
  }
  if (artifact.liveSource === "repository") {
    return `https://github.com/${repoFullName}/blob/HEAD/${artifact.file}`;
  }
  if (artifact.liveSource === "shared") {
    return `https://github.com/${sharedSourceFullName}/blob/HEAD/${artifact.file}`;
  }
  return null;
}

function configArtifactDescription(artifact: VisibleConfigArtifact): string {
  if (artifact.state === "active") {
    if (artifact.liveSource === "repository") {
      return `Repository supplies ${artifact.file}; the latest review used repository config.`;
    }
    return artifact.liveSource === "shared"
      ? `Shared owner configuration supplies ${artifact.file}; the latest review used it.`
      : `Hosted organization ${artifact.file} is active; the latest review used it.`;
  }
  if (artifact.state === "pending") {
    const source =
      artifact.liveSource === "repository"
        ? `Repository ${artifact.file}`
        : artifact.liveSource === "shared"
          ? `Shared owner configuration ${artifact.file}`
          : `Hosted organization ${artifact.file}`;
    return `${source} is set up but not yet exercised. It takes effect on the next review.`;
  }
  if (artifact.state === "removed") {
    return `${artifact.file ?? artifact.label} is no longer present. Postil defaults apply on the next review.`;
  }
  if (artifact.recordedSource === "none") {
    return artifact.lastKnownLiveFile
      ? `Could not check GitHub just now; no completed review has recorded a config source. The last successful check found repository ${artifact.lastKnownLiveFile}.`
      : "Could not check GitHub just now; no completed review has recorded a config source.";
  }
  const lastKnown = artifact.lastKnownLiveFile
    ? ` The last successful check found repository ${artifact.lastKnownLiveFile}.`
    : "";
  return `Could not check GitHub just now; showing what the last review used: ${artifact.recordedSource} ${artifact.file}.${lastKnown}`;
}
