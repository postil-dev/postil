import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ReportsHeader } from "@/components/reports-header";

describe("ReportsHeader", () => {
  test("offers a secondary account action when another installation can be added", () => {
    const markup = renderToStaticMarkup(
      <ReportsHeader
        login="octocat"
        addAccountUrl="https://github.com/apps/postil-dev/installations/new"
      />,
    );

    expect(markup).toContain("Recent reviews, octocat");
    expect(markup).toContain("Add GitHub account");
    expect(markup).toContain('class="btn-secondary text-sm"');
    expect(markup).toContain("https://github.com/apps/postil-dev/installations/new");
  });

  test("leaves installation to the prominent empty-state action when there are no accounts", () => {
    const markup = renderToStaticMarkup(<ReportsHeader login="octocat" />);

    expect(markup).not.toContain("Add GitHub account");
  });
});
