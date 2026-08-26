import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OrganizationAuthorizationFields } from "@/app/cli/authorize/organization-authorization-fields";

describe("CLI device authorization organization choice", () => {
  test("renders one organization as a fixed budget source", () => {
    const markup = renderToStaticMarkup(
      <OrganizationAuthorizationFields
        organizations={[{ slug: "acme", name: "Acme Engineering" }]}
      />,
    );

    expect(markup).toContain('type="hidden"');
    expect(markup).toContain('name="orgSlug"');
    expect(markup).toContain('value="acme"');
    expect(markup).toContain("Acme Engineering");
    expect(markup).not.toContain('type="radio"');
  });

  test("renders multiple organizations as one labelled radio group", () => {
    const markup = renderToStaticMarkup(
      <OrganizationAuthorizationFields
        organizations={[
          { slug: "acme", name: "Acme Engineering" },
          { slug: "acme-labs", name: "Acme Labs" },
        ]}
      />,
    );

    expect(markup).toContain("<fieldset");
    expect(markup).toContain("<legend");
    expect(markup).toContain("Use review budget from");
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup.match(/name="orgSlug"/g)).toHaveLength(2);
    expect(markup.match(/required=""/g)).toHaveLength(2);
    expect(markup).toContain("min-h-12");
    expect(markup).toContain("focus-within:ring-2");
    expect(markup).toContain("has-[:checked]:border-rust");
    expect(markup).toContain("acme-labs");
  });

  test("preserves complete organization identities in narrow choices", () => {
    const sharedPrefix = "International Platform Engineering and Reliability";
    const firstName = `${sharedPrefix} Europe`;
    const secondName = `${sharedPrefix} Americas`;
    const secondSlug =
      "international-platform-engineering-and-reliability-americas";
    const markup = renderToStaticMarkup(
      <OrganizationAuthorizationFields
        organizations={[
          {
            slug: "international-platform-engineering-and-reliability-europe",
            name: firstName,
          },
          { slug: secondSlug, name: secondName },
        ]}
      />,
    );

    expect(markup).toContain(firstName);
    expect(markup).toContain(secondName);
    expect(markup).toContain(secondSlug);
    expect(markup).toContain("[overflow-wrap:anywhere]");
    expect(markup).not.toContain("truncate");
  });
});
