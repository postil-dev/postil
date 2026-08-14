import { beforeEach, describe, expect, mock, test } from "bun:test";

let role = "admin";
let installationRows = [
  {
    githubInstallationId: 42,
    accountLogin: "acme",
    accountType: "Organization",
  },
];
let tokenCalls = 0;
let tokenError: Error | null = null;

const schema = {
  installations: {
    id: "installations.id",
    orgId: "installations.org_id",
    githubInstallationId: "installations.github_installation_id",
    accountLogin: "installations.account_login",
    accountType: "installations.account_type",
  },
};

mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("@/lib/db", () => ({
  getDb: () => fakeDb(),
  getPool: () => ({}),
  schema,
}));
mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () => ({
    ok: true,
    db: fakeDb(),
    user: { id: 7 },
    org: { id: 20 },
    membership: { id: 1, role },
  }),
}));
mock.module("@/lib/github/app-auth", () => ({
  apiBase: () => "https://api.github.test",
  buildAppJwt: () => "app-token",
  getInstallationToken: async () => {
    tokenCalls += 1;
    if (tokenError) throw tokenError;
    return "installation-token";
  },
  normalizePrivateKey: (value: string) => value,
}));

const { checkRepositoryAccess } = await import("@/app/orgs/[slug]/actions");

beforeEach(() => {
  role = "admin";
  installationRows = [
    {
      githubInstallationId: 42,
      accountLogin: "acme",
      accountType: "Organization",
    },
  ];
  tokenCalls = 0;
  tokenError = null;
});

describe("checkRepositoryAccess", () => {
  test("requires an organization administrator", async () => {
    role = "member";

    await expect(checkRepositoryAccess({ status: "idle" }, form())).rejects.toThrow(
      "this action requires an organization admin",
    );
    expect(tokenCalls).toBe(0);
  });

  test("does not query GitHub when the owner is outside the installation account", async () => {
    const result = await checkRepositoryAccess({ status: "idle" }, form("other", "repository"));

    expect(result).toEqual({
      status: "unknown",
      message: "The repository owner must match a GitHub App installation for this organization.",
    });
    expect(tokenCalls).toBe(0);
  });

  test("returns unknown when GitHub cannot complete the listing", async () => {
    tokenError = new Error("GitHub unavailable");

    expect(await checkRepositoryAccess({ status: "idle" }, form())).toEqual({
      status: "unknown",
      message: "Repository access could not be confirmed. Try again.",
      settingsUrl: "https://github.com/organizations/acme/settings/installations/42",
    });
    expect(tokenCalls).toBe(1);
  });
});

function form(owner = "acme", name = "repository"): FormData {
  const data = new FormData();
  data.set("slug", "acme");
  data.set("owner", owner);
  data.set("name", name);
  return data;
}

function fakeDb(): any {
  return {
    select() {
      const chain = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          return Promise.resolve(installationRows);
        },
      };
      return chain;
    },
  };
}
