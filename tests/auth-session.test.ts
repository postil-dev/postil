import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as dbModule from "@/lib/db";

let sessionUser: { id: number; login: string } | null;
let membershipSlugs: string[];
let queryCount: number;

mock.module("@/lib/session", () => ({
  getSessionUser: async () => sessionUser,
}));

mock.module("@/lib/db", () => ({
  ...dbModule,
  getDb: () => fakeDb(),
}));

const { GET } = await import("@/app/api/auth/session/route");

beforeEach(() => {
  sessionUser = { id: 7, login: "octocat" };
  membershipSlugs = [];
  queryCount = 0;
});

describe("GET /api/auth/session", () => {
  test("returns an unauthenticated response without querying memberships", async () => {
    sessionUser = null;

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(queryCount).toBe(0);
  });

  test("links a user with one organization directly to its dashboard", async () => {
    membershipSlugs = ["postil-dev"];

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      login: "octocat",
      dashboardHref: "/orgs/postil-dev",
    });
    expect(queryCount).toBe(1);
  });

  test("links users with multiple organizations to the reports index", async () => {
    membershipSlugs = ["postil-dev", "octo-org"];

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).dashboardHref).toBe("/reports");
  });

  test("links users without organizations to the reports index", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).dashboardHref).toBe("/reports");
  });
});

function fakeDb(): any {
  const rows = membershipSlugs.slice(0, 2).map((slug) => ({ slug }));
  const chain = {
    select() {
      queryCount += 1;
      return chain;
    },
    from() {
      return chain;
    },
    innerJoin() {
      return chain;
    },
    where() {
      return chain;
    },
    limit() {
      return Promise.resolve(rows);
    },
  };
  return chain;
}
