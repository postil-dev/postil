import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as dbModule from "@/lib/db";

const ORIGINAL_FETCH = globalThis.fetch;
let organizationGithubId: number;
let persistedUserId: number;
let fetchCount: number;
let identityWrites: Array<{ githubId: number; login: string }>;

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
  test("synchronizes an actor identity after a matching live organization response", async () => {
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
  });

  test("returns null without mutating cached membership after a live 404", async () => {
    globalThis.fetch = testFetch(async () => new Response(null, { status: 404 }));

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
  });

  test("recognizes an existing personal-account owner without a membership request", async () => {
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
  });

  test("creates only the identity for a verified admin who has never signed in", async () => {
    persistedUserId = 91;

    expect(
      await loadLiveApprovalActor(
        { orgId: 7, installationAccountType: "Organization" },
        { id: 501, login: "admin" },
        "octo/repository",
        "installation-token",
      ),
    ).toEqual({
      userId: 91,
      githubId: "501",
      login: "admin",
      role: "admin",
    });
    expect(fetchCount).toBe(1);
    expect(identityWrites).toEqual([{ githubId: 501, login: "admin" }]);
  });

  test("contains no membership cache writer or generation-marker bypass", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "lib", "github", "approval-actor.ts"),
      "utf8",
    );

    expect(source).not.toContain("schema.orgMembers");
    expect(source).not.toContain("markGenerationFencedMembershipWriter");
    expect(source).not.toContain(".transaction(");
    expect(source).not.toContain(".delete(");
    expect(source).toContain(".insert(schema.users)");
  });
});

function fakeDb(): any {
  let table: unknown;
  let identity: { githubId: number; login: string } | undefined;
  const chain = {
    select() {
      return chain;
    },
    from(nextTable: unknown) {
      table = nextTable;
      return chain;
    },
    where() {
      return chain;
    },
    limit() {
      if (table === dbModule.schema.organizations) {
        return Promise.resolve([{ githubId: organizationGithubId }]);
      }
      throw new Error("unexpected approval actor table");
    },
    insert(nextTable: unknown) {
      if (nextTable !== dbModule.schema.users) {
        throw new Error("approval actor may only persist users");
      }
      return chain;
    },
    values(value: { githubId: number; login: string }) {
      identity = value;
      return chain;
    },
    onConflictDoUpdate() {
      return chain;
    },
    returning() {
      if (!identity) throw new Error("missing approval actor identity");
      identityWrites.push(identity);
      return Promise.resolve([{ id: persistedUserId }]);
    },
  };
  return chain;
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
