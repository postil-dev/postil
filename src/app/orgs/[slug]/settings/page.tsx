import type { Metadata } from "next";
import Link from "next/link";

import { and, desc, eq, sql } from "drizzle-orm";

import { schema } from "@/lib/db";
import { requireOrgMembership } from "@/lib/org-access";
import {
  isVisibleConfigArtifact,
  resolveConfigArtifacts,
  type VisibleConfigSource,
} from "../config-resolution";
import { SettingsForm } from "../settings-form";

export const metadata: Metadata = {
  title: "Organization settings",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const sourceClass: Record<VisibleConfigSource, string> = {
  repository: "border-gate text-gate",
  organization: "border-rust text-rust",
  unknown: "border-stone text-charcoal/55",
};

const sourceLabel: Record<VisibleConfigSource, string> = {
  repository: "repo",
  organization: "org",
  unknown: "unknown",
};

export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { db, org, membership } = await requireOrgMembership(slug);
  if (membership.role !== "admin") {
    throw new Error("this page requires an organization admin");
  }

  const settings = (
    await db
      .select({
        apiBase: schema.orgSettings.apiBase,
        model: schema.orgSettings.model,
        modelCascade: schema.orgSettings.modelCascade,
        configYaml: schema.orgSettings.configYaml,
        guardrailsMd: schema.orgSettings.guardrailsMd,
        contentPolicyMd: schema.orgSettings.contentPolicyMd,
        hasKey: sql<boolean>`${schema.orgSettings.apiKeyCiphertext} IS NOT NULL`,
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
    })
    .from(schema.repositories)
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(eq(schema.installations.orgId, org.id))
    .orderBy(schema.repositories.fullName);

  const latestRepoReviews = await db
    .selectDistinctOn([schema.reviews.repositoryId], {
      repositoryId: schema.reviews.repositoryId,
      configFiles: schema.reviews.configFiles,
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
    .map((repo) => {
      const latestReview = latestRepoReviewByRepositoryId.get(repo.id);
      const artifacts = resolveConfigArtifacts(latestReview?.configFiles).filter(
        isVisibleConfigArtifact,
      );
      return { repo, latestReview, artifacts };
    })
    .filter((summary) => summary.artifacts.length > 0);
  const showConfigFiles = repos.length === 0 || repoConfigSummaries.length > 0;

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

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
        <div>
          <p className="eyebrow">Organization settings</p>
          <SettingsForm slug={org.slug} settings={settings} />
        </div>

        {showConfigFiles && (
          <div>
            <p className="eyebrow">Config files</p>
            <div className="card mt-3 divide-y divide-stone/60">
              {repoConfigSummaries.map(({ repo, latestReview, artifacts }) => {
                return (
                  <div key={repo.id} className="space-y-3 px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-mono text-sm">{repo.fullName}</p>
                        <p className="font-mono text-[11px] text-charcoal/55">
                          {repo.enabled ? "enabled" : "disabled"}
                          {!latestReview ? " · no completed review yet" : ""}
                        </p>
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
                              {artifact.source === "repository" &&
                                `Repository supplies ${artifact.file}.`}
                              {artifact.source === "organization" &&
                                `Falls back to hosted organization ${artifact.file}.`}
                              {artifact.source === "unknown" &&
                                "No completed review has recorded this file yet."}
                            </p>
                          </div>
                          <span
                            className={`h-fit rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${sourceClass[artifact.source]}`}
                          >
                            {sourceLabel[artifact.source]}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {repos.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-charcoal/50">
                  No repositories. Install the GitHub App on this organization.
                </p>
              )}
            </div>
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
