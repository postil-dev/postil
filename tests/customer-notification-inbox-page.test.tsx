import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";

let role = "member";
let rows: Array<Record<string, unknown>> = [];

mock.module("@/lib/org-access", () => ({
  requireOrgMembership: async () => ({
    db: { execute: async () => ({ rows }) },
    user: { id: 7, login: "octocat" },
    org: { id: 20, slug: "acme", name: "Acme", plan: "beta" },
    membership: { id: 1, role },
  }),
  getOrgMembership: async () => ({
    ok: true,
    db: { execute: async () => ({ rows }) },
    user: { id: 7, login: "octocat" },
    org: { id: 20, slug: "acme", name: "Acme", plan: "beta" },
    membership: { id: 1, role },
  }),
}));

mock.module("next/cache", () => ({ revalidatePath: () => undefined }));

const { default: OrganizationNotificationsPage } = await import(
  "@/app/orgs/[slug]/notifications/page"
);

beforeEach(() => {
  role = "member";
  rows = [];
});

describe("customer notification inbox page", () => {
  test("renders an empty state without admin-only controls", async () => {
    const page = await OrganizationNotificationsPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("You’re all caught up.");
    expect(markup).not.toContain("Mark all read");
    expect(markup).toContain("/orgs/acme");
  });

  test("renders unread state, safe action metadata, and read controls", async () => {
    role = "admin";
    rows = [{
      id: "9",
      severity: "critical",
      category: "billing",
      title: "Payment needs attention",
      body: "Update billing details to keep private-repository reviews active.",
      actionLabel: "Open billing",
      actionHref: "/orgs/acme/billing",
      createdAt: "2026-07-20T12:00:00.000Z",
      readAt: null,
    }];
    const page = await OrganizationNotificationsPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Payment needs attention");
    expect(markup).toContain("critical notification");
    expect(markup).toContain("Mark all read");
    expect(markup).toContain("Mark read");
    expect(markup).toContain('href="/orgs/acme/billing"');
    expect(markup).not.toMatch(/provider|model|stack trace/i);
  });

  test("uses role-scoped keyset pagination and never queries operator incidents", async () => {
    const source = await readFile(
      new URL("../src/app/orgs/[slug]/notifications/page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("event.visibility = 'members'");
    expect(source).toContain("event.visibility IN ('members', 'admins')");
    expect(source).toContain("(event.created_at, event.id) <");
    expect(source).not.toMatch(/\bOFFSET\b/);
    expect(source).not.toContain("operator_alert_deliveries");
    expect(source).not.toContain("private_monitor_incidents");
  });
});
