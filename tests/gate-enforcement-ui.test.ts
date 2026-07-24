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
    expect(page).toContain("GitHub blocks a merge only when the");
    expect(page).toContain("exact App and context required by an active ruleset");
    expect(page).toContain("exact App and context required by classic branch protection");
    expect(page).toContain("Missing identities and unreadable rules stay unverified");
    expect(page).toContain("No changes are applied from this page");
    expect(page).toContain("Rollback:");
    expect(page).toContain("any source");
    expect(page).toContain("other App");
    expect(page).toContain("CopyAgentPromptButton");
    expect(page).toContain("buildGateEnforcementAgentPrompt");
    expect(page).toContain("lastCheckedLabel");
    expect(page).toContain("nextCheckLabel");
    expect(button).toContain("animate-spin");
    expect(button).toContain('progress === "completed"');
    expect(button).toContain("router.refresh()");
    expect(button).toContain("MAX_POLL_ATTEMPTS");
    expect(button).toContain("Checked");
    expect(button).toContain("aria-label={label}");
    expect(button).not.toContain('state.status === "queued" ? "Queued"');
  });

  test("keeps unexercised config badges neutral", () => {
    const page = readFileSync(
      new URL("../src/app/orgs/[slug]/settings/page.tsx", import.meta.url),
      "utf8",
    );
    const badgeClasses = page.slice(page.indexOf("function configArtifactClass"));
    expect(badgeClasses).toContain('if (artifact.state === "removed") return "border-rust text-rust"');
    expect(badgeClasses.slice(0, badgeClasses.indexOf("}"))).not.toContain('"pending"');
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
