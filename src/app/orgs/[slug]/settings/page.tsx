import type { Metadata } from "next";
import Link from "next/link";

import { and, desc, eq, sql } from "drizzle-orm";

import { schema } from "@/lib/db";
import { PrivateBillingNotice } from "@/components/private-billing-notice";
import { getRepoConfigProbes } from "@/lib/github/config-probe";
import { requireOrgMembership } from "@/lib/org-access";
import { canProcessPrivateRepository } from "@/lib/private-repository-entitlement";
import { deriveRepoHealth, getRepoHealthRows, type RepoHealth } from "@/lib/repo-health";
import { formatRelativeTime } from "@/lib/time";
import {
  isVisibleConfigArtifact,
  resolveConfigArtifacts,
  type VisibleConfigArtifact,
} from "../config-resolution";
import { ConfigRecheckButton } from "../config-recheck-button";
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
        escalationEmail: schema.orgSettings.escalationEmail,
        hasKey: sql<boolean>`${schema.orgSettings.apiKeyCiphertext} IS NOT NULL`,
        hasAdditionalAuth: sql<boolean>`${schema.orgSettings.apiAuthHeaderCiphertext} IS NOT NULL AND ${schema.orgSettings.apiAuthValueCiphertext} IS NOT NULL`,
      })
      .from(schema.orgSettings)
      .where(eq(schema.orgSettings.orgId, org.id))
      .limit(1)
  )[0];

  const repos = await db
    .select({
      id: schema.repositories.id,
      fullName: schema.repositories.fullName,
      enabled: schema.repositories.enabled,
      private: schema.repositories.private,
      githubInstallationId: schema.installations.githubInstallationId,
    })
    .from(schema.repositories)
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
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
      ).filter(isVisibleConfigArtifact);
      const healthRow = healthByRepositoryId.get(repo.id);
      const health = healthRow ? deriveRepoHealth(healthRow, now) : null;
      return { repo, latestReview, artifacts, healthRow, health };
    })
    .filter((summary) => summary.artifacts.length > 0);
  const showConfigFiles =
    repos.length === 0 || repoConfigSummaries.length > 0 || enabledRepos.length > 0;
  const privateAccess = repos.some((repo) => repo.private && repo.enabled)
    ? await canProcessPrivateRepository(db, {
        orgId: org.id,
        repositoryPrivate: true,
      })
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
        liveConfigFilesByRepositoryId={liveConfigFilesByRepositoryId}
      />

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
        <div>
          <p className="eyebrow">Organization settings</p>
          <SettingsForm slug={org.slug} settings={settings} />
        </div>

        {showConfigFiles && (
          <div>
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

function configArtifactLabel(artifact: VisibleConfigArtifact): string {
  if (artifact.state === "active") return artifact.liveSource === "repository" ? "repo" : "org";
  return artifact.state;
}

function configArtifactClass(artifact: VisibleConfigArtifact): string {
  if (artifact.state === "active") {
    return artifact.liveSource === "repository"
      ? "border-gate text-gate"
      : "border-rust text-rust";
  }
  if (artifact.state === "unverified") return "border-stone text-charcoal/55";
  return "border-rust text-rust";
}

function configArtifactDescription(artifact: VisibleConfigArtifact): string {
  if (artifact.state === "active") {
    return artifact.liveSource === "repository"
      ? `Repository supplies ${artifact.file}; the latest review used repository config.`
      : `Hosted organization ${artifact.file} is active; the latest review used it.`;
  }
  if (artifact.state === "pending") {
    const source =
      artifact.liveSource === "repository"
        ? `Repository ${artifact.file}`
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
