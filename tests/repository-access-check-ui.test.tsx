import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RepositoryAccessCheckResult } from "@/app/orgs/[slug]/repository-access-check";

describe("RepositoryAccessCheckResult", () => {
  test("shows selected access with the GitHub installation settings action", () => {
    const markup = renderToStaticMarkup(
      <RepositoryAccessCheckResult
        state={{
          status: "selected",
          message: "acme/repository is selected for this GitHub App installation.",
          settingsUrl: "https://github.com/organizations/acme/settings/installations/42",
        }}
      />,
    );

    expect(markup).toContain("is selected for this GitHub App installation.");
    expect(markup).toContain("Manage repository access on GitHub");
    expect(markup).toContain("settings/installations/42");
  });

  test("shows a clear not-selected result", () => {
    const markup = renderToStaticMarkup(
      <RepositoryAccessCheckResult
        state={{
          status: "not_selected",
          message: "acme/repository is not selected for this GitHub App installation.",
          settingsUrl: "https://github.com/organizations/acme/settings/installations/42",
        }}
      />,
    );

    expect(markup).toContain("is not selected for this GitHub App installation.");
    expect(markup).toContain("Manage repository access on GitHub");
  });
});
