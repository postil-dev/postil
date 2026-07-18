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

interface SuspendedInstallation {
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
}

const MAX_REPOSITORY_NAMES = 5;

export function SuspendedInstallationsNotice({
  installations,
  isAdmin,
}: {
  installations: readonly SuspendedInstallation[];
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
