import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OrganizationSwitcherList } from "@/components/organization-switcher";
import { nextOrganizationFocusIndex } from "@/components/organization-switcher-menu";

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
    expect(markup).toContain("bg-paper");
    expect(markup).not.toContain("bg-cream");
    expect(markup).toContain('role="menu"');
    expect(markup).toContain("hidden=\"\"");
  });

  test("wraps keyboard focus through every account and the account index", () => {
    expect(nextOrganizationFocusIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextOrganizationFocusIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextOrganizationFocusIndex(1, "Home", 3)).toBe(0);
    expect(nextOrganizationFocusIndex(1, "End", 3)).toBe(2);
    expect(nextOrganizationFocusIndex(0, "ArrowDown", 0)).toBe(-1);
  });

  test("does not label an unknown current slug as the first account", () => {
    const markup = renderToStaticMarkup(
      <OrganizationSwitcherList
        currentSlug="removed-account"
        organizations={[
          { slug: "morgaesis", name: "morgaesis" },
          { slug: "postil-dev", name: "postil-dev" },
        ]}
      />,
    );

    expect(markup).toContain("Switch account");
    expect(markup).toContain("Current account: removed-account");
  });
});
