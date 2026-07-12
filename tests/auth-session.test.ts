import { beforeEach, describe, expect, mock, test } from "bun:test";

import { shouldShowInstallApp } from "@/components/mobile-nav";
import * as dbModule from "@/lib/db";

let sessionUser: { id: number; login: string } | null;
let membershipSlugs: string[];
let activeInstallation: boolean;
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
  activeInstallation = false;
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
      hasActiveInstallation: false,
    });
    expect(queryCount).toBe(2);
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

  test("reports whether the user already has an active installation", async () => {
    membershipSlugs = ["postil-dev"];
    activeInstallation = true;

    const response = await GET();

    expect(await response.json()).toMatchObject({ hasActiveInstallation: true });
  });
});

describe("install navigation affordance", () => {
  test("is hidden while session state loads and after an active installation is found", () => {
    expect(shouldShowInstallApp(undefined)).toBe(false);
    expect(
      shouldShowInstallApp({ dashboardHref: "/reports", hasActiveInstallation: true }),
    ).toBe(false);
  });

  test("remains available to signed-out users and users without an installation", () => {
    expect(shouldShowInstallApp(null)).toBe(true);
    expect(
      shouldShowInstallApp({ dashboardHref: "/reports", hasActiveInstallation: false }),
    ).toBe(true);
  });
});

function fakeDb(): any {
  let selectingInstallations = false;
  const chain = {
    select(selection: Record<string, unknown>) {
      queryCount += 1;
      selectingInstallations = "id" in selection;
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
      return Promise.resolve(
        selectingInstallations
          ? activeInstallation
            ? [{ id: 42 }]
            : []
          : membershipSlugs.slice(0, 2).map((slug) => ({ slug })),
      );
    },
  };
  return chain;
}
