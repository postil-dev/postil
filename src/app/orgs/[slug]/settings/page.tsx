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
  buildGateEnforcementAgentPrompt,
  buildGateEnforcementDryRunPlan,
  deriveGateEnforcementPresentation,
} from "@/lib/gate-enforcement-health";
import {
  gateEnforcementSweepIntervalMs,
  getGateEnforcementSweepSchedule,
} from "@/lib/queue";
import {
  isVisibleConfigArtifact,
  ownerConfigRepositoryFullName,
  resolveConfigArtifacts,
  sharedConfigFilesAvailableToReviews,
  type VisibleConfigArtifact,
} from "../config-resolution";
import { ConfigRecheckButton } from "../config-recheck-button";
import { CopyAgentPromptButton } from "../copy-agent-prompt-button";
import { GateEnforcementRecheckButton } from "../gate-enforcement-recheck-button";
import { RepoHealthBanner } from "../repo-health-banner";
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
  const [probes, repoHealthRows, sweepSchedule] = await Promise.all([
    getRepoConfigProbes(db, enabledRepos, { now }),
    getRepoHealthRows(db, org.id),
    getGateEnforcementSweepSchedule(getPool(), gateEnforcementSweepIntervalMs()),
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

        {showConfigFiles && (
          <div>
            {enabledRepos.length > 0 && (
              <GateEnforcementCoverage
                slug={org.slug}
                repositories={repos.filter((repo) => repo.enabled)}
                now={now}
                nextSweepDueAt={sweepSchedule.nextDueAt}
              />
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="eyebrow">Config files</p>
              {enabledRepos.length > 0 && (
                <ConfigRecheckButton
                  slug={org.slug}
                  lastCheckedLabel={lastCheckedLabelFrom(
                    probes.map((probe) => probe.probedAt),
                    now,
                  )}
                />
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
                            <p className="font-mono text-sm">{repo.fullName}</p>
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
                          {artifacts.map((artifact) => (
                            <div
                              key={artifact.key}
                              className="grid gap-2 rounded-card border border-stone/70 px-3 py-2 sm:grid-cols-[1fr_auto]"
                            >
                              <div>
                                <p className="font-mono text-[11px] text-charcoal">
                                  {artifact.label}
                                </p>
                                <p className="mt-0.5 text-xs text-charcoal/60">
                                  {configArtifactDescription(artifact)}
                                </p>
                              </div>
                              <span
                                className={`h-fit rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${configArtifactClass(artifact)}`}
                              >
                                {configArtifactLabel(artifact)}
                              </span>
                            </div>
                          ))}
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
    </div>
  );
}

function GateEnforcementCoverage({
  slug,
  repositories,
  now,
  nextSweepDueAt,
}: {
  nextSweepDueAt: Date | null;
  slug: string;
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
  const enforcementCounts = repositories.reduce(
    (counts, repository) => {
      const status = deriveGateEnforcementPresentation(
        {
          status: repository.gateEnforcementStatus,
          checkedAt: repository.gateCheckedAt,
          lastError: repository.gateLastError,
        },
        now,
      ).status;
      counts[status] += 1;
      return counts;
    },
    { required: 0, not_required: 0, unknown: 0 },
  );
  const expectedAppId = Number(process.env.GITHUB_APP_ID) || null;
  const nextCheckLabel = nextSweepDueAt === null
    ? null
    : nextSweepDueAt.getTime() > now.getTime()
      ? `next automatic check ${relative(nextSweepDueAt, now)}`
      : "next automatic check is due";
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">Installation health</p>
        <GateEnforcementRecheckButton
          slug={slug}
          lastCheckedLabel={lastCheckedLabelFrom(
            repositories.map((repository) => repository.gateCheckedAt),
            now,
          )}
          nextCheckLabel={nextCheckLabel}
        />
      </div>
      <div className="mt-3 rounded-card border border-stone/70 bg-paper p-4">
        <p className="text-sm text-charcoal">
          Postil publishes <code>postil/gate</code>. GitHub blocks a merge only when the
          default branch requires that check from this App.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 font-mono text-[11px] text-charcoal/65">
          <span>{enforcementCounts.required} enforced</span>
          <span>{enforcementCounts.not_required} not enforced</span>
          <span>{enforcementCounts.unknown} unverified</span>
        </div>
      </div>
      <div className="card mt-3 divide-y divide-stone/60">
        {repositories.map((repository) => {
          const presentation = deriveGateEnforcementPresentation(
            {
              status: repository.gateEnforcementStatus,
              checkedAt: repository.gateCheckedAt,
              lastError: repository.gateLastError,
            },
            now,
          );
          const plan = buildGateEnforcementDryRunPlan(
            presentation,
            repository.gateDefaultBranch,
          );
          const anySource =
            repository.gateEvidence?.branchProtection.match === "any_source" ||
            repository.gateEvidence?.activeRules.match === "any_source";
          const identityUnknown =
            repository.gateEvidence?.branchProtection.match === "unknown_identity" ||
            repository.gateEvidence?.activeRules.match === "unknown_identity";
          const foreignSource =
            repository.gateEvidence?.branchProtection.match === "foreign_app" ||
            repository.gateEvidence?.activeRules.match === "foreign_app";
          const detail = presentation.status === "required" &&
              repository.gateEvidence?.branchProtection.exactMatch
            ? "exact App and context required by classic branch protection"
            : presentation.status === "required" &&
                repository.gateEvidence?.activeRules.exactMatch
              ? "exact App and context required by an active ruleset"
            : anySource
              ? "postil/gate accepts any source"
              : foreignSource
                ? "postil/gate requires another App"
                : identityUnknown
                  ? "classic protection names postil/gate, but its App binding is not readable"
                  : `branch protection: ${repository.gateBranchProtection ?? "unknown"}`;
          const settingsHref = `https://github.com/${repository.fullName}/settings/rules`;
          return (
            <div key={repository.id} className="px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{repository.fullName}</p>
                  <p className="mt-0.5 text-xs text-charcoal/60">
                    {repository.gateDefaultBranch
                      ? `default: ${repository.gateDefaultBranch}`
                      : "default branch unavailable"}
                    {repository.gateCheckedAt
                      ? ` · checked ${relative(repository.gateCheckedAt, now)}`
                      : " · not checked"}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-stone px-2.5 py-0.5 font-mono text-[11px] text-charcoal/70">
                  <StatusIcon
                    kind={presentation.status === "required"
                      ? "pass"
                      : presentation.status === "not_required"
                        ? "warn"
                        : "info"}
                    size={13}
                  />
                  {presentation.enforcementLabel}
                </span>
              </div>
              <p className="mt-2 text-xs text-charcoal/70">{presentation.consequence}</p>
              <p className="mt-0.5 text-xs text-charcoal/55">{detail}</p>
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
                  {plan.action === "none" ? "Verified rule" : "Setup plan"}
                </summary>
                <div className="mt-3 space-y-2">
                  <p><strong>Target:</strong> {plan.target}</p>
                  <p><strong>Rule:</strong> {plan.desiredRule}</p>
                  <p><strong>Effect:</strong> {plan.impact}</p>
                  <p><strong>Risk:</strong> {plan.risk}</p>
                  <p><strong>Rollback:</strong> {plan.rollback}</p>
                  <p>No changes are applied from this page.</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      href={settingsHref}
                      className="inline-block text-rust underline"
                      rel="noopener noreferrer"
                    >
                      Open repository rules
                    </a>
                    {plan.action !== "none" && (
                      <CopyAgentPromptButton
                        prompt={buildGateEnforcementAgentPrompt({
                          repoFullName: repository.fullName,
                          defaultBranch: repository.gateDefaultBranch,
                          appId: expectedAppId,
                        })}
                      />
                    )}
                  </div>
                </div>
              </details>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-charcoal/60">
        Enforced means GitHub names <code>postil/gate</code> and binds it to the Postil
        App. Missing identities and unreadable rules stay unverified. See the{" "}
        <Link href="/docs/gate" className="text-rust hover:underline">gate guide</Link>.
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

function lastCheckedLabelFrom(
  checkedTimes: ReadonlyArray<Date | null>,
  now: Date,
): string | null {
  const newest = checkedTimes.reduce<Date | null>(
    (latest, value) =>
      value !== null && (latest === null || value.getTime() > latest.getTime())
        ? value
        : latest,
    null,
  );
  return newest === null ? null : `checked ${relative(newest, now)}`;
}

function configArtifactLabel(artifact: VisibleConfigArtifact): string {
  if (artifact.state === "active") {
    if (artifact.recordedSource === "shared") return "shared";
    return artifact.liveSource === "repository" ? "repo" : "org";
  }
  return artifact.state;
}

function configArtifactClass(artifact: VisibleConfigArtifact): string {
  if (artifact.state === "active") {
    return artifact.liveSource === "repository"
      ? "border-gate text-gate"
      : "border-rust text-rust";
  }
  // A configured-but-unexercised file and an unreadable probe are neither a
  // pass nor a failure; only a removed file needs attention styling.
  if (artifact.state === "removed") return "border-rust text-rust";
  return "border-stone text-charcoal/55";
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
