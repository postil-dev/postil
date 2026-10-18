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
    expect(page).toContain("Installation health");
    expect(page).toContain("statusRank");
    expect(page).toContain(".filter((entry) => entry.count > 0)");
    expect(page).toContain("<strong>Evidence:</strong>");
    expect(page).toContain("repository Administration (read-only) permission");
    expect(page).not.toContain("rounded-full border px-2.5");
    expect(page).toContain("an active ruleset requires the check from the Postil App");
    expect(page).toContain("branch protection requires the check from the Postil App");
    expect(page).toContain("Missing identities and unreadable rules stay unverified");
    expect(page).toContain("No changes are applied from this page");
    expect(page).toContain("Rollback:");
    expect(page).toContain("any app may satisfy it");
    expect(page).toContain("required from a different app");
    expect(button).toContain("animate-spin");
    expect(button).toContain('progress === "completed"');
    expect(button).toContain("router.refresh()");
    expect(button).toContain("MAX_POLL_ATTEMPTS");
    expect(button).toContain("Checked");
    expect(button).not.toContain('state.status === "queued" ? "Queued"');
  });

  test("scopes private repository health to an authenticated organization admin", () => {
    const page = readFileSync(
      new URL("../src/app/orgs/[slug]/settings/page.tsx", import.meta.url),
      "utf8",
    );
    const membershipCheck = page.indexOf("requireOrgMembership(slug)");
    const adminCheck = page.indexOf('membership.role !== "admin"');
    const repositoryQuery = page.indexOf("const repos = await db");
    const organizationScope = page.indexOf(
      "eq(schema.installations.orgId, org.id)",
      repositoryQuery,
    );
    expect(membershipCheck).toBeGreaterThan(-1);
    expect(adminCheck).toBeGreaterThan(membershipCheck);
    expect(repositoryQuery).toBeGreaterThan(adminCheck);
    expect(organizationScope).toBeGreaterThan(repositoryQuery);
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
