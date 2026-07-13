import { afterEach, describe, expect, test } from "bun:test";

import {
  githubAppInstallUrl,
  githubInstallationSettingsUrl,
} from "@/lib/github-app";

const ORIGINAL_SLUG = process.env.GITHUB_APP_SLUG;

afterEach(() => {
  if (ORIGINAL_SLUG === undefined) {
    delete process.env.GITHUB_APP_SLUG;
  } else {
    process.env.GITHUB_APP_SLUG = ORIGINAL_SLUG;
  }
});

describe("GitHub App install URL", () => {
  test("defaults to the hosted app's slug", () => {
    delete process.env.GITHUB_APP_SLUG;

    expect(githubAppInstallUrl()).toBe(
      "https://github.com/apps/postil-dev/installations/new",
    );
  });

  test("honors GITHUB_APP_SLUG", () => {
    process.env.GITHUB_APP_SLUG = "postil";

    expect(githubAppInstallUrl()).toBe(
      "https://github.com/apps/postil/installations/new",
    );
  });

  test("ignores a blank GITHUB_APP_SLUG", () => {
    process.env.GITHUB_APP_SLUG = "   ";

    expect(githubAppInstallUrl()).toBe(
      "https://github.com/apps/postil-dev/installations/new",
    );
  });
});

describe("GitHub App installation settings URL", () => {
  test("targets an organization installation", () => {
    expect(
      githubInstallationSettingsUrl({
        githubInstallationId: 123,
        accountLogin: "postil dev",
        accountType: "Organization",
      }),
    ).toBe("https://github.com/organizations/postil%20dev/settings/installations/123");
  });

  test("targets a personal installation", () => {
    expect(
      githubInstallationSettingsUrl({
        githubInstallationId: 456,
        accountLogin: "octocat",
        accountType: "User",
      }),
    ).toBe("https://github.com/settings/installations/456");
  });
});
