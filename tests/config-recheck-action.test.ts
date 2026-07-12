import { beforeEach, describe, expect, mock, test } from "bun:test";

let refreshAcquired = true;
let probeResult: Array<{ repositoryId: number; ok: boolean; files: string[] }> = [];
let probeError: Error | null = null;
let revalidatedPaths: string[] = [];

const repositories = [
  { repositoryId: 1, githubInstallationId: 10, fullName: "acme/one" },
  { repositoryId: 2, githubInstallationId: 10, fullName: "acme/two" },
];

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
    githubInstallationId: "installations.github_installation_id",
  },
  repositories: {
    id: "repositories.id",
    installationId: "repositories.installation_id",
    fullName: "repositories.full_name",
    enabled: "repositories.enabled",
  },
};

mock.module("next/cache", () => ({
  revalidatePath: (path: string) => revalidatedPaths.push(path),
}));

mock.module("@/lib/session", () => ({
  getSessionUser: async () => ({ id: 7 }),
}));

mock.module("@/lib/db", () => ({
  schema,
  getDb: () => fakeDb(),
}));

mock.module("@/lib/github/config-probe", () => ({
  getRepoConfigProbes: async () => {
    if (probeError) throw probeError;
    return probeResult;
  },
}));

const { refreshOrgConfigProbes } = await import("@/app/orgs/[slug]/actions");

beforeEach(() => {
  refreshAcquired = true;
  probeResult = [];
  probeError = null;
  revalidatedPaths = [];
});

describe("refreshOrgConfigProbes", () => {
  test("returns checked counts and a timestamp after forcing a refresh", async () => {
    probeResult = [
      { repositoryId: 1, ok: true, files: [".postil.yaml", ".postil/guardrails.md"] },
      { repositoryId: 2, ok: false, files: [] },
    ];

    const result = await refreshOrgConfigProbes({ status: "idle" }, form());

    expect(result).toMatchObject({
      status: "success",
      repositoryCount: 2,
      successfulCount: 1,
      failedCount: 1,
      configFileCount: 2,
      message: "Checked 2 repositories; 1 could not be reached.",
    });
    expect(result.status === "success" && Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
    expect(revalidatedPaths).toEqual(["/orgs/acme/settings"]);
  });

  test("returns a distinct cooldown state when another refresh ran recently", async () => {
    refreshAcquired = false;

    expect(await refreshOrgConfigProbes({ status: "idle" }, form())).toEqual({
      status: "cooldown",
      retryAfterSeconds: 30,
      message: "Checked recently. Try again in 30 seconds.",
    });
  });

  test("returns an actionable error state when refresh fails", async () => {
    probeError = new Error("GitHub unavailable");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      expect(await refreshOrgConfigProbes({ status: "idle" }, form())).toEqual({
        status: "error",
        message: "Could not re-check config files. Try again.",
      });
    } finally {
      console.error = originalError;
    }
  });
});

function form(): FormData {
  const data = new FormData();
  data.set("slug", "acme");
  return data;
}

function fakeDb(): any {
  return {
    execute: async () => ({ rows: refreshAcquired ? [{ orgId: 20 }] : [] }),
    select(selection: Record<string, unknown>) {
      const rows = "repositoryId" in selection
        ? repositories
        : "role" in selection
          ? [{ role: "admin" }]
          : [{ id: 20 }];
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
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(rows).then(resolve);
        },
      };
      return chain;
    },
  };
}
