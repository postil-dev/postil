import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RepoHealthBanner,
  SuspendedInstallationsNotice,
} from "@/app/orgs/[slug]/repo-health-banner";
import type { RepoHealthRow } from "@/lib/repo-health";
import { HOSTED_REVIEW_UNAVAILABLE_MESSAGE } from "@/lib/review-outcome";

const NOW = new Date("2026-07-11T12:00:00.000Z");

function row(overrides: Partial<RepoHealthRow> = {}): RepoHealthRow {
  return {
    repositoryId: 1,
    repositoryFullName: "postil-dev/example",
    githubInstallationId: 123,
    accountLogin: "postil-dev",
    accountType: "Organization",
    lastEnabledAt: new Date("2026-07-01T12:00:00.000Z"),
    installationSuspended: false,
    attemptCount: 0,
    completedCount: 0,
    lastCompletedAt: null,
    latestAttemptStatus: null,
    latestAttemptErrorMessage: null,
    latestAttemptAt: null,
    latestAttemptPublicId: null,
    ...overrides,
  };
}

describe("RepoHealthBanner", () => {
  test("renders one silent-repository summary with config and access actions", () => {
    const markup = renderToStaticMarkup(
      <RepoHealthBanner
        slug="postil-dev"
        rows={[row()]}
        now={NOW}
        liveConfigFilesByRepositoryId={new Map([[1, [".postil.yaml"]]])}
      />,
    );

    expect(markup).toContain("Enabled but never reviewed.");
    expect(markup).toContain("has been enabled for 10 days");
    expect(markup).toContain(".postil.yaml");
    expect(markup).toContain(
      "https://github.com/organizations/postil-dev/settings/installations/123",
    );
  });

  test("renders failing summary and the latest failed run action", () => {
    const markup = renderToStaticMarkup(
      <RepoHealthBanner
        slug="postil-dev"
        rows={[
          row({
            attemptCount: 1,
            latestAttemptStatus: "failed",
            latestAttemptAt: new Date("2026-07-11T11:00:00.000Z"),
            latestAttemptPublicId: "be60075e-b495-4940-8314-1b5c6b837f55",
          }),
        ]}
        now={NOW}
      />,
    );

    expect(markup).toContain("Reviews are failing on postil-dev/example.");
    expect(markup).toContain("attempted 1 review");
    expect(markup).toContain("The most recent attempt failed 1h ago.");
    expect(markup).toContain("/orgs/postil-dev/runs/be60075e-b495-4940-8314-1b5c6b837f55");
  });

  test("renders nothing for healthy and suspended repositories", () => {
    const markup = renderToStaticMarkup(
      <RepoHealthBanner
        slug="postil-dev"
        rows={[
          row({ completedCount: 1 }),
          row({ repositoryId: 2, installationSuspended: true }),
        ]}
        now={NOW}
      />,
    );

    expect(markup).toBe("");
  });

  test("does not turn a managed pause into a repository failure warning", () => {
    const markup = renderToStaticMarkup(
      <RepoHealthBanner
        slug="postil-dev"
        rows={[
          row({
            attemptCount: 1,
            latestAttemptStatus: "failed",
            latestAttemptErrorMessage: HOSTED_REVIEW_UNAVAILABLE_MESSAGE,
            latestAttemptAt: new Date("2026-07-11T11:00:00.000Z"),
          }),
        ]}
        now={NOW}
        managedReviewsPaused
      />,
    );

    expect(markup).toBe("");
  });

  test("suppresses first-review warnings during a managed pause", () => {
    const markup = renderToStaticMarkup(
      <RepoHealthBanner
        slug="postil-dev"
        rows={[row()]}
        now={NOW}
        managedReviewsPaused
      />,
    );

    expect(markup).toBe("");
  });
});

describe("SuspendedInstallationsNotice", () => {
  const installations = [
    {
      githubInstallationId: 123,
      accountLogin: "postil-dev",
      accountType: "Organization",
    },
  ];

  test("gives organization admins the GitHub management action", () => {
    const markup = renderToStaticMarkup(
      <SuspendedInstallationsNotice installations={installations} isAdmin />,
    );

    expect(markup).toContain("Manage postil-dev on GitHub");
    expect(markup).toContain(
      "https://github.com/organizations/postil-dev/settings/installations/123",
    );
    expect(markup).not.toContain("Ask a GitHub organization owner");
  });

  test("directs non-admins to an owner without exposing an unusable settings action", () => {
    const markup = renderToStaticMarkup(
      <SuspendedInstallationsNotice installations={installations} isAdmin={false} />,
    );

    expect(markup).toContain("Ask a GitHub organization owner to manage the installation.");
    expect(markup).not.toContain("Manage postil-dev on GitHub");
    expect(markup).not.toContain("settings/installations/123");
  });
});
