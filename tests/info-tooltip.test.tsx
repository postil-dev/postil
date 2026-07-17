import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InfoTooltip } from "@/components/info-tooltip";

describe("InfoTooltip", () => {
  test("connects a keyboard-focusable control to its explanation", () => {
    const markup = renderToStaticMarkup(
      <InfoTooltip
        id="active-author-help"
        label="What counts as an active author?"
      >
        One identity counts once.
      </InfoTooltip>,
    );

    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-describedby="active-author-help"');
    expect(markup).toContain('aria-label="What counts as an active author?"');
    expect(markup).toContain('id="active-author-help"');
    expect(markup).toContain('role="tooltip"');
    expect(markup).toContain("group-focus-within:visible");
  });
});
