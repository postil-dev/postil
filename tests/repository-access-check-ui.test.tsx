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
          message:
            "acme/repository cannot receive Postil reviews or checks because it is not selected for this GitHub App installation. Postil cannot inspect configuration in this repository.",
          settingsUrl: "https://github.com/organizations/acme/settings/installations/42",
        }}
      />,
    );

    expect(markup).toContain("cannot receive Postil reviews or checks");
    expect(markup).toContain("Manage repository access on GitHub");
  });

  test("explains that an excluded repository cannot receive reviews or checks without inferring config state", () => {
    const markup = renderToStaticMarkup(
      <RepositoryAccessCheckResult
        state={{
          status: "not_selected",
          message:
            "acme/repository cannot receive Postil reviews or checks because it is not selected for this GitHub App installation. Postil cannot inspect configuration in this repository.",
          settingsUrl: "https://github.com/organizations/acme/settings/installations/42",
        }}
      />,
    );

    expect(markup).toContain("cannot receive Postil reviews or checks");
    expect(markup).toContain("cannot inspect configuration");
    expect(markup).not.toContain("configuration is absent");
    expect(markup).not.toContain("configuration is present");
  });

  test("explains that an absent installation prevents reviews and checks without inferring config state", () => {
    const markup = renderToStaticMarkup(
      <RepositoryAccessCheckResult
        state={{
          status: "not_installed",
          message:
            "acme/repository cannot receive Postil reviews or checks because the GitHub App is not installed for acme. Postil cannot inspect configuration in this repository.",
        }}
      />,
    );

    expect(markup).toContain("GitHub App is not installed");
    expect(markup).toContain("cannot receive Postil reviews or checks");
    expect(markup).not.toContain("configuration is absent");
    expect(markup).not.toContain("configuration is present");
  });

  test("renders unknown as an alert without claiming a clean result", () => {
    const markup = renderToStaticMarkup(
      <RepositoryAccessCheckResult
        state={{
          status: "unknown",
          message: "Repository access could not be confirmed. Try again.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("could not be confirmed");
    expect(markup).not.toContain("no findings");
  });
});
