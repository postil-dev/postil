import { beforeEach, describe, expect, mock, test } from "bun:test";

let sessionUser: { id: number } | null = { id: 10 };
let orgRows: Array<{ id: number }> = [{ id: 20 }];
let memberRows: Array<{ role: string }> = [{ role: "admin" }];
let repoRows: Array<{
  id: number;
  installationId: number;
  githubRepoId: number;
  fullName: string;
  private: boolean;
  enabled: boolean;
}> = [];
const repositoryUpdates: Array<{ enabled: boolean }> = [];
const enablementEvents: Array<Record<string, unknown>> = [];
const revalidatedPaths: string[] = [];

const schema = {
  organizations: { id: "organizations.id", slug: "organizations.slug" },
  orgMembers: {
    orgId: "org_members.org_id",
    userId: "org_members.user_id",
    role: "org_members.role",
  },
  installations: {
    id: "installations.id",
    orgId: "installations.org_id",
  },
  repositories: {
    id: "repositories.id",
    installationId: "repositories.installation_id",
    githubRepoId: "repositories.github_repo_id",
    fullName: "repositories.full_name",
    private: "repositories.private",
    enabled: "repositories.enabled",
  },
  repositoryEnablementEvents: "repository_enablement_events",
};

mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidatedPaths.push(path);
  },
}));

mock.module("@/lib/session", () => ({
  getSessionUser: async () => sessionUser,
  getVerifiedSessionUser: async () =>
    sessionUser
      ? { ok: true, user: sessionUser }
      : { ok: false, reason: "unauthenticated" },
}));

mock.module("@/lib/db", () => ({
  getDb: () => fakeDb(),
  getPool: () => {
    throw new Error("getPool is not used by repository toggle tests");
  },
  schema,
}));

mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () => {
    if (!sessionUser) return { ok: false, reason: "unauthenticated" };
    const org = orgRows[0];
    if (!org) return { ok: false, reason: "not_found" };
    const membership = memberRows[0];
    if (!membership) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      db: fakeDb(),
      user: sessionUser,
      org,
      membership: { id: 1, role: membership.role },
    };
  },
}));

const { toggleRepository } = await import("@/app/orgs/[slug]/actions");

function fakeDb(): any {
  const db: any = {
    select(selection: Record<string, unknown>) {
      const rows =
        "role" in selection ? memberRows : "githubRepoId" in selection ? repoRows : orgRows;
      const chain = {
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
    },
    update() {
      return {
        set(values: { enabled: boolean }) {
          repositoryUpdates.push(values);
          return {
            where() {
              repoRows = repoRows.map((repo) => ({ ...repo, enabled: values.enabled }));
              return {
                returning() {
                  return Promise.resolve([{ id: 30 }]);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          enablementEvents.push(values);
          return Promise.resolve([]);
        },
      };
    },
    transaction<T>(fn: (tx: any) => Promise<T>) {
      return fn(db);
    },
  };
  return db;
}

function toggleForm(enable: boolean): FormData {
  const form = new FormData();
  form.set("slug", "acme");
  form.set("repositoryId", "30");
  form.set("enable", enable ? "true" : "false");
  return form;
}

beforeEach(() => {
  sessionUser = { id: 10 };
  orgRows = [{ id: 20 }];
  memberRows = [{ role: "admin" }];
  repoRows = [
    {
      id: 30,
      installationId: 40,
      githubRepoId: 999,
      fullName: "acme/private",
      private: true,
      enabled: true,
    },
  ];
  repositoryUpdates.length = 0;
  enablementEvents.length = 0;
  revalidatedPaths.length = 0;
});

describe("toggleRepository billing events", () => {
  test("appends a disable event with repo visibility when an admin disables a repository", async () => {
    await toggleRepository(toggleForm(false));

    expect(repositoryUpdates).toEqual([{ enabled: false }]);
    expect(enablementEvents).toEqual([
      {
        orgId: 20,
        repositoryId: 30,
        githubRepoId: 999,
        repositoryFullName: "acme/private",
        repositoryPrivate: true,
        action: "disable",
        actorUserId: 10,
        source: "dashboard",
      },
    ]);
    expect(revalidatedPaths).toEqual(["/orgs/acme", "/orgs/acme/billing"]);
  });

  test("appends a new enable event without mutating existing history", async () => {
    repoRows = [{ ...repoRows[0]!, enabled: false, private: false, fullName: "acme/public" }];

    await toggleRepository(toggleForm(true));
    const firstEvent = { ...enablementEvents[0] };
    await toggleRepository(toggleForm(false));

    expect(enablementEvents).toHaveLength(2);
    expect(enablementEvents[0]).toEqual(firstEvent);
    expect(firstEvent).toMatchObject({
      repositoryFullName: "acme/public",
      repositoryPrivate: false,
      action: "enable",
    });
    expect(enablementEvents[1]).toMatchObject({
      repositoryFullName: "acme/public",
      repositoryPrivate: false,
      action: "disable",
    });
  });

  test("rejects non-admins before repository update or event insert", async () => {
    memberRows = [{ role: "member" }];

    await expect(toggleRepository(toggleForm(false))).rejects.toThrow(
      "this action requires an organization admin",
    );
    expect(repositoryUpdates).toEqual([]);
    expect(enablementEvents).toEqual([]);
  });

  test("does not append an event for a stale same-state request", async () => {
    await toggleRepository(toggleForm(true));

    expect(repositoryUpdates).toEqual([{ enabled: true }]);
    expect(enablementEvents).toEqual([]);
  });
});
