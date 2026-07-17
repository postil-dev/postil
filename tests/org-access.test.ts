import { beforeEach, describe, expect, mock, test } from "bun:test";

let verification:
  | { ok: true; user: { id: number; login: string } }
  | { ok: false; reason: "unauthenticated" | "verification_unavailable" };
let orgRows: Array<{ id: number; slug: string }>;
let membershipRows: Array<{ id: number; role: string }>;
let queryCount: number;

mock.module("@/lib/session", () => ({
  getVerifiedSessionUser: async () => verification,
}));

mock.module("@/lib/db", () => ({
  schema: {
    organizations: { id: "organizations.id", slug: "organizations.slug" },
    orgMembers: {
      id: "org_members.id",
      orgId: "org_members.org_id",
      userId: "org_members.user_id",
      role: "org_members.role",
    },
  },
  getDb: () => fakeDb(),
}));

const { getOrgMembership } = await import("@/lib/org-access");

beforeEach(() => {
  verification = { ok: true, user: { id: 7, login: "octocat" } };
  orgRows = [{ id: 20, slug: "acme" }];
  membershipRows = [{ id: 30, role: "admin" }];
  queryCount = 0;
});

describe("organization access", () => {
  test("fails closed before querying tenant data when verification is unavailable", async () => {
    verification = { ok: false, reason: "verification_unavailable" };

    expect(await getOrgMembership("acme")).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(queryCount).toBe(0);
  });

  test("returns a verified membership with its current GitHub role", async () => {
    const result = await getOrgMembership("acme");

    expect(result).toMatchObject({
      ok: true,
      user: { id: 7 },
      org: { id: 20, slug: "acme" },
      membership: { id: 30, role: "admin" },
    });
    expect(queryCount).toBe(2);
  });

  test("does not disclose an organization without a verified membership row", async () => {
    membershipRows = [];

    expect(await getOrgMembership("acme")).toEqual({ ok: false, reason: "not_found" });
  });
});

function fakeDb(): any {
  let selectingMembership = false;
  const chain = {
    select(selection?: Record<string, unknown>) {
      queryCount += 1;
      selectingMembership = Boolean(selection && "role" in selection);
      return chain;
    },
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    limit() {
      return Promise.resolve(selectingMembership ? membershipRows : orgRows);
    },
  };
  return chain;
}
