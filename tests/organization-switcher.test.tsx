import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OrganizationSwitcherList } from "@/components/organization-switcher";

describe("organization switcher", () => {
  test("stays out of the way for one account", () => {
    const markup = renderToStaticMarkup(
      <OrganizationSwitcherList
        currentSlug="morgaesis"
        organizations={[{ slug: "morgaesis", name: "morgaesis" }]}
      />,
    );

    expect(markup).toBe("");
  });

  test("links every accessible account and the account index", () => {
    const markup = renderToStaticMarkup(
      <OrganizationSwitcherList
        currentSlug="morgaesis"
        organizations={[
          { slug: "morgaesis", name: "morgaesis" },
          { slug: "postil-dev", name: "postil-dev" },
        ]}
      />,
    );

    expect(markup).toContain("Switch GitHub account. Current account: morgaesis");
    expect(markup).toContain('href="/orgs/morgaesis"');
    expect(markup).toContain('href="/orgs/postil-dev"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('href="/reports"');
  });
});
