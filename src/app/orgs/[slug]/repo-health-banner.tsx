import Link from "next/link";

import { githubInstallationSettingsUrl } from "@/lib/github-app";
import { formatRelativeTime } from "@/lib/time";
import {
  deriveRepoHealth,
  type RepoHealthRow,
} from "@/lib/repo-health";

interface RepoHealthBannerProps {
  slug: string;
  rows: readonly RepoHealthRow[];
  now: Date;
  managedReviewsPaused?: boolean;
  liveConfigFilesByRepositoryId?: ReadonlyMap<number, readonly string[]>;
}

interface InstallationRef {
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
}

const MAX_REPOSITORY_NAMES = 5;

interface RemovedRepository {
  githubRepoId: number;
  fullName: string;
  occurredAt: Date;
}

/**
 * Link to GitHub's repository picker for each installation behind this
 * organization. Choosing repositories is a GitHub App permission, so the
 * picker is the only place it can happen and the dashboard's job is to make it
 * reachable from the list it governs. Only administrators can save a selection
 * there, matching the suspended-installation action.
 */
export function AddRepositoriesLinks({
  installations,
  isAdmin,
}: {
  installations: readonly InstallationRef[];
  isAdmin: boolean;
}) {
  if (!isAdmin || installations.length === 0) return null;
  const named = installations.length > 1;

  return (
    <span className="flex flex-wrap items-baseline gap-2">
      {installations.map((installation) => (
        <a
          key={installation.githubInstallationId}
          href={githubInstallationSettingsUrl(installation)}
          title={`Choose which ${installation.accountLogin} repositories Postil reviews`}
          className="rounded-card border border-stone px-2 py-0.5 font-mono text-xs text-charcoal/70 transition-colors hover:border-charcoal hover:text-charcoal"
        >
          + add{named ? ` ${installation.accountLogin}` : ""}
        </a>
      ))}
    </span>
  );
}

/**
 * Repositories the installation covered recently and no longer does. GitHub's
 * picker replaces the selection on save, so a repository can leave without
 * anyone intending it, and Postil receives no further events for it.
 */
export function RemovedRepositoriesNotice({
  repositories,
  now,
}: {
  repositories: readonly RemovedRepository[];
  now: Date;
}) {
  if (repositories.length === 0) return null;

  return (
    <div className="card mt-3 border-rust p-4 text-sm">
      <p>
        <span className="font-medium text-rust">
          Removed from the installation.
        </span>{" "}
        Postil no longer receives pull requests or <code>@postil</code> mentions
        for {repositories.length === 1 ? "this repository" : "these repositories"}.
        Re-add {repositories.length === 1 ? "it" : "them"} on GitHub to resume
        reviews.
      </p>
      <ul className="mt-2 space-y-1">
        {repositories.slice(0, MAX_REPOSITORY_NAMES).map((repository) => (
          <li key={repository.githubRepoId} className="font-mono text-xs">
            {repository.fullName}{" "}
            <span className="text-charcoal/60">
              {relative(repository.occurredAt, now)}
            </span>
          </li>
        ))}
      </ul>
      {repositories.length > MAX_REPOSITORY_NAMES && (
        <p className="mt-2 text-xs text-charcoal/60">
          and {repositories.length - MAX_REPOSITORY_NAMES} more
        </p>
      )}
    </div>
  );
}

export function SuspendedInstallationsNotice({
  installations,
  isAdmin,
}: {
  installations: readonly InstallationRef[];
  isAdmin: boolean;
}) {
  if (installations.length === 0) return null;

  return (
    <div className="card mt-6 border-rust p-5">
      <p className="text-sm">
        <span className="font-medium text-rust">
          Installation{installations.length === 1 ? "" : "s"} suspended.
        </span>{" "}
        The GitHub App installation on{" "}
        <span className="font-mono text-xs">
          {installations.map((installation) => installation.accountLogin).join(", ")}
        </span>{" "}
        {installations.length === 1 ? "is" : "are"} suspended, so Postil does not run reviews
        for {installations.length === 1 ? "that account" : "those accounts"}.
      </p>
      {isAdmin ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {installations.map((installation) => (
            <a
              key={installation.githubInstallationId}
              href={githubInstallationSettingsUrl(installation)}
              className="btn-secondary text-xs"
            >
              Manage {installation.accountLogin} on GitHub
            </a>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-charcoal/60">
          Ask a GitHub organization owner to manage the installation.
        </p>
      )}
    </div>
  );
}

export function RepoHealthBanner({
  slug,
  rows,
  now,
  managedReviewsPaused = false,
  liveConfigFilesByRepositoryId = new Map(),
}: RepoHealthBannerProps) {
  const neverReviewed = rows.filter(
    (row) => deriveRepoHealth(row, now, managedReviewsPaused) === "never-reviewed",
  );
  const failing = rows.filter(
    (row) => deriveRepoHealth(row, now, managedReviewsPaused) === "failing",
  );
  if (neverReviewed.length === 0 && failing.length === 0) return null;

  const affected = [...neverReviewed, ...failing];
  const installationLinks = uniqueInstallations(affected);
  const latestFailure = failing
    .filter((row) => row.latestAttemptAt !== null && row.latestAttemptPublicId !== null)
    .sort(
      (left, right) =>
        (right.latestAttemptAt?.getTime() ?? 0) - (left.latestAttemptAt?.getTime() ?? 0),
    )[0];

  return (
    <div className="card mt-6 border-rust p-5">
      <div className="space-y-3 text-sm">
        {neverReviewed.length > 0 && (
          <p>
            <span className="font-medium text-rust">
              {neverReviewed.length === 1
                ? "Enabled but never reviewed."
                : "Repositories enabled but never reviewed."}
            </span>{" "}
            {neverReviewed.length === 1 ? (
              <>
                <span className="font-mono text-xs">{neverReviewed[0]?.repositoryFullName}</span>{" "}
                has been enabled for {enabledDays(neverReviewed[0]!, now)} days and no review has
                ever run for it. If pull requests were opened in that time, the GitHub App is not
                reaching this repository: check Repository access under GitHub Settings → GitHub
                Apps → Postil. If none were opened, this is expected; the first review runs on the
                next pull request.
                {liveConfigSentence(neverReviewed[0]!, liveConfigFilesByRepositoryId)}
              </>
            ) : (
              <>
                {formatRepositoryNames(neverReviewed)} have been enabled for at least 7 days and no
                review has ever run for them. If pull requests were opened in that time, the GitHub
                App is not reaching these repositories: check Repository access under GitHub
                Settings → GitHub Apps → Postil. If none were opened, this is expected; the first
                review runs on the next pull request.
                {neverReviewed.slice(0, MAX_REPOSITORY_NAMES).map((row) => {
                  const sentence = liveConfigSentence(row, liveConfigFilesByRepositoryId, true);
                  return sentence ? <span key={row.repositoryId}>{sentence}</span> : null;
                })}
              </>
            )}
          </p>
        )}

        {failing.length > 0 && (
          <p>
            <span className="font-medium text-rust">
              {failing.length === 1
                ? `Reviews are failing on ${failing[0]?.repositoryFullName}.`
                : `Reviews are failing on ${failing.length} repositories.`}
            </span>{" "}
            {failing.length > 1 && <>{formatRepositoryNames(failing)}. </>}
            Postil received pull requests and attempted{" "}
            {reviewAttemptCount(failing)} {reviewAttemptCount(failing) === 1 ? "review" : "reviews"},
            but none has completed.
            {latestFailure?.latestAttemptAt && (
              <> The most recent attempt failed {relative(latestFailure.latestAttemptAt, now)}.</>
            )}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {installationLinks.map((installation) => (
          <Link
            key={installation.githubInstallationId}
            href={githubInstallationSettingsUrl(installation)}
            className="btn-secondary text-xs"
          >
            Repository access on GitHub
          </Link>
        ))}
        {latestFailure?.latestAttemptPublicId && (
          <Link
            href={`/orgs/${slug}/runs/${latestFailure.latestAttemptPublicId}`}
            className="btn-secondary text-xs"
          >
            View the failed run
          </Link>
        )}
      </div>
    </div>
  );
}

function enabledDays(row: RepoHealthRow, now: Date): number {
  return Math.floor((now.getTime() - row.lastEnabledAt.getTime()) / (24 * 60 * 60 * 1_000));
}

function reviewAttemptCount(rows: readonly RepoHealthRow[]): number {
  return rows.reduce((total, row) => total + row.attemptCount, 0);
}

function relative(value: Date, now: Date): string {
  return formatRelativeTime(value.toISOString(), now.getTime());
}

function formatRepositoryNames(rows: readonly RepoHealthRow[]): React.ReactNode {
  const visible = rows.slice(0, MAX_REPOSITORY_NAMES);
  const remaining = rows.length - visible.length;
  return (
    <>
      {visible.map((row, index) => (
        <span key={row.repositoryId}>
          {index > 0 ? ", " : ""}
          <span className="font-mono text-xs">{row.repositoryFullName}</span>
        </span>
      ))}
      {remaining > 0 ? ` and ${remaining} more` : ""}
    </>
  );
}

function liveConfigSentence(
  row: RepoHealthRow,
  filesByRepositoryId: ReadonlyMap<number, readonly string[]>,
  nameRepository = false,
): React.ReactNode {
  const file = filesByRepositoryId.get(row.repositoryId)?.[0];
  if (!file) return null;
  return (
    <>
      {" "}
      {nameRepository ? (
        <>
          The <code>{file}</code> in <code>{row.repositoryFullName}</code>
        </>
      ) : (
        <>
          Its <code>{file}</code>
        </>
      )}{" "}
      on the default branch has never been used by a review.
    </>
  );
}

function uniqueInstallations(rows: readonly RepoHealthRow[]): RepoHealthRow[] {
  return [...new Map(rows.map((row) => [row.githubInstallationId, row])).values()];
}
