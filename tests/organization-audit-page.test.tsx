import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";

let role = "member";
let rows: Array<Record<string, unknown>> = [];
let executeCalls = 0;

mock.module("@/lib/org-access", () => ({
  requireOrgMembership: async () => ({
    db: {
      execute: async () => {
        executeCalls += 1;
        return { rows };
      },
    },
    org: { id: 20, slug: "acme", name: "Acme", plan: "beta" },
    membership: { id: 1, role },
  }),
}));

const { default: OrganizationAuditPage } = await import(
  "@/app/orgs/[slug]/settings/audit/page"
);
const AUDIT_PAGE_SIZE = 50;

beforeEach(() => {
  role = "member";
  rows = [];
  executeCalls = 0;
});

describe("organization audit page", () => {
  test("denies non-admin members before querying audit records", async () => {
    await expect(
      OrganizationAuditPage({
        params: Promise.resolve({ slug: "acme" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("this page requires an organization admin");
    expect(executeCalls).toBe(0);
  });

  test("renders actors and readable event and source labels", async () => {
    role = "admin";
    rows = [
      {
        eventId: "2",
        occurredAt: "2026-07-15T10:00:00.000Z",
        action: "enable",
        repositoryFullName: "acme/service",
        repositoryPrivate: true,
        source: "github_installation",
        actorLogin: "octocat",
      },
      {
        eventId: "1",
        occurredAt: new Date("2026-07-15T09:00:00.000Z"),
        action: "disable",
        repositoryFullName: "acme/old-service",
        repositoryPrivate: false,
        source: "migration_baseline",
        actorLogin: null,
      },
    ];

    const page = await OrganizationAuditPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Enabled");
    expect(markup).toContain("Jul 15, 2026, 10:00 AM");
    expect(markup).toContain("acme/service");
    expect(markup).toContain("(private)");
    expect(markup).toContain("@octocat");
    expect(markup).toContain("GitHub App installation");
    expect(markup).toContain("Disabled");
    expect(markup).toContain("Imported baseline");
    expect(markup).toContain("System");
    expect(markup).not.toContain("github_installation");
    expect(markup).not.toContain("migration_baseline");
  });

  test("renders one bounded page with navigation", async () => {
    role = "admin";
    rows = Array.from({ length: AUDIT_PAGE_SIZE + 1 }, (_, index) => ({
      eventId: String(index + 1),
      occurredAt: new Date("2026-07-15T10:00:00.000Z"),
      action: "enable",
      repositoryFullName: `acme/repo-${index}`,
      repositoryPrivate: false,
      source: "dashboard",
      actorLogin: "octocat",
    }));

    const page = await OrganizationAuditPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(page);

    expect((markup.match(/acme\/repo-/g) ?? []).length).toBe(AUDIT_PAGE_SIZE);
    expect(markup).not.toContain(`acme/repo-${AUDIT_PAGE_SIZE}`);
    expect(markup).toContain('href="/orgs/acme/settings/audit?after=');
    expect(markup).toContain("Next");
  });

  test("treats an out-of-range event ID cursor as invalid", async () => {
    role = "admin";
    const after = Buffer.from(JSON.stringify({
      occurredAt: "2026-07-15T10:00:00.000Z",
      eventId: "9223372036854775808",
    })).toString("base64url");

    const page = await OrganizationAuditPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({ after }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).not.toContain("Newest");
    expect(executeCalls).toBe(1);
  });

  test("uses a stable tuple cursor instead of offset pagination", async () => {
    const source = await readFile(
      new URL("../src/app/orgs/[slug]/settings/audit/page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\bOFFSET\b/);
    expect(source).toContain("repositoryEnablementEvents.occurredAt} DESC");
    expect(source).toContain("repositoryEnablementEvents.id} DESC");
    expect(source).toContain("< (${cursor.occurredAt}, ${cursor.eventId}::bigint)");
    expect(source).toContain("!/^[1-9]\\d*$/.test(value.eventId)");
    expect(source).not.toContain("Number(event.eventId)");
  });
});
