import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as dbModule from "@/lib/db";

const ORIGINAL_FETCH = globalThis.fetch;

interface CachedMembership {
  orgId: number;
  userId: number;
  role: "member" | "admin";
}

let organizationGithubId: number;
let persistedUserId: number;
let fetchCount: number;
let identityWrites: Array<{ githubId: number; login: string }>;
let cachedMemberships: CachedMembership[];

mock.module("@/lib/db", () => ({
  ...dbModule,
  getDb: () => fakeDb(),
}));

mock.module("@/lib/github/app-auth", () => ({
  apiBase: () => "https://api.github.test",
}));

const { loadLiveApprovalActor } = await import("@/lib/github/approval-actor");

beforeEach(() => {
  organizationGithubId = 2001;
  persistedUserId = 77;
  fetchCount = 0;
  identityWrites = [];
  cachedMemberships = [
    { orgId: 7, userId: 77, role: "member" },
    { orgId: 9, userId: 77, role: "admin" },
  ];
  globalThis.fetch = testFetch(async () =>
    jsonResponse({
      state: "active",
      role: "admin",
      user: { id: 501, login: "admin" },
      organization: { id: 2001, login: "octo" },
    }),
  );
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("live approval actor", () => {
  test("uses a live organization role without changing a cached role", async () => {
    const before = structuredClone(cachedMemberships);

    expect(
      await loadLiveApprovalActor(
        { orgId: 7, installationAccountType: "Organization" },
        { id: 501, login: "admin" },
        "octo/repository",
        "installation-token",
      ),
    ).toEqual({
      userId: 77,
      githubId: "501",
      login: "admin",
      role: "admin",
    });
    expect(fetchCount).toBe(1);
    expect(identityWrites).toEqual([{ githubId: 501, login: "admin" }]);
    expect(cachedMemberships).toEqual(before);
  });

  test("does not create a cached membership for a verified actor", async () => {
    cachedMemberships = [];

    expect(
      await loadLiveApprovalActor(
        { orgId: 7, installationAccountType: "Organization" },
        { id: 501, login: "admin" },
        "octo/repository",
        "installation-token",
      ),
    ).toEqual({
      userId: 77,
      githubId: "501",
      login: "admin",
      role: "admin",
    });
    expect(cachedMemberships).toEqual([]);
  });

  test("returns a live member role without relying on a cached admin role", async () => {
    cachedMemberships[0] = { orgId: 7, userId: 77, role: "admin" };
    const before = structuredClone(cachedMemberships);
    globalThis.fetch = testFetch(async () =>
      jsonResponse({
        state: "active",
        role: "member",
        user: { id: 501, login: "admin" },
        organization: { id: 2001, login: "octo" },
      }),
    );

    expect(
      await loadLiveApprovalActor(
        { orgId: 7, installationAccountType: "Organization" },
        { id: 501, login: "admin" },
        "octo/repository",
        "installation-token",
      ),
    ).toEqual({
      userId: 77,
      githubId: "501",
      login: "admin",
      role: "member",
    });
    expect(cachedMemberships).toEqual(before);
  });

  test("keeps cached memberships after a live membership rejection", async () => {
    const before = structuredClone(cachedMemberships);
    globalThis.fetch = testFetch(
      async () => new Response(null, { status: 404 }),
    );

    expect(
      await loadLiveApprovalActor(
        { orgId: 7, installationAccountType: "Organization" },
        { id: 501, login: "admin" },
        "octo/repository",
        "installation-token",
      ),
    ).toBeNull();
    expect(fetchCount).toBe(1);
    expect(identityWrites).toEqual([]);
    expect(cachedMemberships).toEqual(before);
  });

  test("authorizes a personal-account owner without changing cached memberships", async () => {
    const before = structuredClone(cachedMemberships);
    organizationGithubId = 501;

    expect(
      await loadLiveApprovalActor(
        { orgId: 7, installationAccountType: "User" },
        { id: 501, login: "admin" },
        "admin/repository",
        "installation-token",
      ),
    ).toEqual({
      userId: 77,
      githubId: "501",
      login: "admin",
      role: "admin",
    });
    expect(fetchCount).toBe(0);
    expect(identityWrites).toEqual([{ githubId: 501, login: "admin" }]);
    expect(cachedMemberships).toEqual(before);
  });
});

function fakeDb(): any {
  const db = {
    select() {
      let table: unknown;
      const query = {
        from(nextTable: unknown) {
          table = nextTable;
          return query;
        },
        where() {
          return query;
        },
        limit() {
          if (table === dbModule.schema.organizations) {
            return Promise.resolve([{ githubId: organizationGithubId }]);
          }
          if (table === dbModule.schema.users) {
            return Promise.resolve([{ id: persistedUserId }]);
          }
          throw new Error("unexpected approval actor table");
        },
      };
      return query;
    },
    insert(table: unknown) {
      let value: Record<string, unknown> | undefined;
      const query = {
        values(nextValue: Record<string, unknown>) {
          value = nextValue;
          return query;
        },
        onConflictDoUpdate() {
          if (table === dbModule.schema.orgMembers) {
            const membership = value as unknown as CachedMembership;
            const existing = cachedMemberships.find(
              (row) =>
                row.orgId === membership.orgId &&
                row.userId === membership.userId,
            );
            if (existing) existing.role = membership.role;
            else cachedMemberships.push({ ...membership });
          }
          return query;
        },
        returning() {
          if (table !== dbModule.schema.users || !value) {
            throw new Error("approval actor may only return a persisted user");
          }
          identityWrites.push(value as { githubId: number; login: string });
          return Promise.resolve([{ id: persistedUserId }]);
        },
      };
      return query;
    },
    delete(table: unknown) {
      return {
        where() {
          if (table === dbModule.schema.orgMembers) cachedMemberships = [];
          return Promise.resolve();
        },
      };
    },
    transaction<T>(operation: (transaction: any) => Promise<T>): Promise<T> {
      return operation(db);
    },
  };
  return db;
}

function testFetch(handler: () => Promise<Response>): typeof fetch {
  const counted = async () => {
    fetchCount += 1;
    return handler();
  };
  return Object.assign(counted, {
    preconnect: ORIGINAL_FETCH.preconnect,
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
