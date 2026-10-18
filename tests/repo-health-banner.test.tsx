import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AddRepositoriesLinks,
  RemovedRepositoriesNotice,
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

describe("AddRepositoriesLinks", () => {
  const installation = {
    githubInstallationId: 123,
    accountLogin: "postil-dev",
    accountType: "Organization",
  };

  test("links the repository picker with hover text and no account label", () => {
    const markup = renderToStaticMarkup(
      <AddRepositoriesLinks installations={[installation]} isAdmin />,
    );

    expect(markup).toContain(
      "https://github.com/organizations/postil-dev/settings/installations/123",
    );
    expect(markup).toContain(
      "Choose which postil-dev repositories Postil reviews",
    );
    expect(markup).toContain("+ add");
    expect(markup).not.toContain("+ add postil-dev");
  });

  test("names each account when the organization has several installations", () => {
    const markup = renderToStaticMarkup(
      <AddRepositoriesLinks
        installations={[
          installation,
          { githubInstallationId: 124, accountLogin: "morgaesis", accountType: "User" },
        ]}
        isAdmin
      />,
    );

    expect(markup).toContain("+ add postil-dev");
    expect(markup).toContain("+ add morgaesis");
    expect(markup).toContain("https://github.com/settings/installations/124");
  });

  test("renders nothing without an installation", () => {
    expect(
      renderToStaticMarkup(<AddRepositoriesLinks installations={[]} isAdmin />),
    ).toBe("");
  });

  test("hides an action non-administrators cannot complete", () => {
    expect(
      renderToStaticMarkup(
        <AddRepositoriesLinks installations={[installation]} isAdmin={false} />,
      ),
    ).toBe("");
  });
});

describe("RemovedRepositoriesNotice", () => {
  test("names repositories the installation no longer covers", () => {
    const markup = renderToStaticMarkup(
      <RemovedRepositoriesNotice
        repositories={[
          {
            githubRepoId: 1251157939,
            fullName: "postil-dev/example",
            occurredAt: new Date("2026-07-11T10:00:00.000Z"),
          },
        ]}
        now={NOW}
      />,
    );

    expect(markup).toContain("Removed from the installation.");
    expect(markup).toContain("postil-dev/example");
    expect(markup).toContain("2h ago");
    expect(markup).toContain("mentions");
  });

  test("renders nothing when every repository is still covered", () => {
    expect(
      renderToStaticMarkup(<RemovedRepositoriesNotice repositories={[]} now={NOW} />),
    ).toBe("");
  });
});
