import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("gate enforcement settings UI", () => {
  test("shows per-repository evidence, re-check feedback, and truthful setup copy", () => {
    const page = readFileSync(
      new URL("../src/app/orgs/[slug]/settings/page.tsx", import.meta.url),
      "utf8",
    );
    const button = readFileSync(
      new URL("../src/app/orgs/[slug]/gate-enforcement-recheck-button.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain("GitHub enforcement");
    expect(page).toContain("binds it to the Postil App");
    expect(page).toContain("Ambiguous or unreadable rules stay unknown");
    expect(page).toContain("any source");
    expect(page).toContain("other App");
    expect(button).toContain("animate-spin");
    expect(button).toContain('progress === "completed"');
    expect(button).toContain("router.refresh()");
    expect(button).toContain("MAX_POLL_ATTEMPTS");
    expect(button).toContain("Checked");
    expect(button).not.toContain('state.status === "queued" ? "Queued"');
  });

  test("describes the hosted check ownership boundary accurately", () => {
    const page = readFileSync(
      new URL("../src/app/how-it-works/page.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain("After the envelope is stored, the control plane completes postil/gate");
    expect(page).toContain("Advisory by default. Blocking when enabled.");
    expect(page).not.toContain("CLI posts inline comments in one batched review and completes postil/review (advisory) and postil/gate");
  });
});
