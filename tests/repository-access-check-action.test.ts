import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let role = "admin";
let accessState: "ok" | "unauthenticated" | "not_found" = "ok";
let organization: { id: number; name: string; githubOrgId: number | null } = {
  id: 20,
  name: "acme",
  githubOrgId: 100,
};
let githubRequestCount = 0;
let githubOwnerResponse = {
  id: 100,
  login: "acme",
  type: "Organization" as const,
};
let probeResult: {
  status: "selected" | "not_installed" | "not_selected" | "unknown";
  installation?: {
    githubInstallationId: number;
    accountLogin: string;
    accountType: "Organization" | "User";
  };
} = {
  status: "selected",
  installation: {
    githubInstallationId: 42,
    accountLogin: "acme",
    accountType: "Organization",
  },
};

mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () => {
    if (accessState === "unauthenticated") return { ok: false, reason: "unauthenticated" };
    if (accessState === "not_found") return { ok: false, reason: "not_found" };
    return {
      ok: true,
      db: {},
      user: { id: 7 },
      org: organization,
      membership: { id: 1, role },
    };
  },
}));
mock.module("@/lib/github/app-auth", () => ({
  apiBase: () => "https://api.github.test",
  buildAppJwt: () => "app-token",
  getAppJwt: () => "app-token",
  getInstallationToken: async () => "installation-token",
  normalizePrivateKey: (value: string) => value,
}));

const { checkRepositoryAccess } = await import("@/app/orgs/[slug]/actions");
const originalFetch = globalThis.fetch;

beforeEach(() => {
  role = "admin";
  accessState = "ok";
  organization = { id: 20, name: "acme", githubOrgId: 100 };
  githubRequestCount = 0;
  githubOwnerResponse = { id: 100, login: "acme", type: "Organization" };
  probeResult = {
    status: "selected",
    installation: {
      githubInstallationId: 42,
      accountLogin: "acme",
      accountType: "Organization",
    },
  };
  globalThis.fetch = (async (input) => {
    githubRequestCount += 1;
    const url = String(input);
    const organizationLookup = url.match(/\/orgs\/([^/]+)\/installation$/);
    if (organizationLookup) {
      if (probeResult.status === "not_installed") return new Response(null, { status: 404 });
      if (probeResult.status === "unknown") return new Response(null, { status: 503 });
      return Response.json({
        id: probeResult.installation?.githubInstallationId ?? 42,
        suspended_at: null,
        account: githubOwnerResponse,
      });
    }
    if (/\/users\/[^/]+\/installation$/.test(url)) return new Response(null, { status: 404 });
    if (url.includes("/installation/repositories")) {
      return Response.json({
        repositories:
          probeResult.status === "selected"
            ? [{ full_name: `${githubOwnerResponse.login}/repository` }]
            : [],
      });
    }
    throw new Error(`unexpected GitHub request ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("checkRepositoryAccess", () => {
  test("requires a signed-in organization administrator", async () => {
    accessState = "unauthenticated";
    await expect(checkRepositoryAccess({ status: "idle" }, form())).rejects.toThrow("not signed in");

    accessState = "ok";
    role = "member";
    await expect(checkRepositoryAccess({ status: "idle" }, form())).rejects.toThrow(
      "this action requires an organization admin",
    );
    expect(githubRequestCount).toBe(0);
  });

  test("does not reveal selection state for an unrelated Postil organization", async () => {
    accessState = "not_found";

    await expect(checkRepositoryAccess({ status: "idle" }, form())).rejects.toThrow(
      "organization not found",
    );
    expect(githubRequestCount).toBe(0);
  });

  test("fails closed when GitHub resolves the owner to a different account ID", async () => {
    githubOwnerResponse = { id: 999, login: "other", type: "Organization" };
    const result = await checkRepositoryAccess({ status: "idle" }, form("other", "repository"));

    expect(result).toEqual({
      status: "unknown",
      message: "Repository access could not be confirmed. Try again.",
    });
    expect(githubRequestCount).toBe(1);
  });

  test("accepts a renamed GitHub owner when its immutable account ID matches", async () => {
    organization = { id: 20, name: "acme", githubOrgId: 100 };
    githubOwnerResponse = { id: 100, login: "renamed", type: "Organization" };

    await expect(
      checkRepositoryAccess({ status: "idle" }, form("renamed", "repository")),
    ).resolves.toEqual({
      status: "selected",
      message: "renamed/repository is selected for this GitHub App installation.",
      settingsUrl: "https://github.com/organizations/renamed/settings/installations/42",
    });
  });

  test("does not query GitHub for an organization without a linked GitHub owner", async () => {
    organization = { id: 20, name: "acme", githubOrgId: null };

    await expect(checkRepositoryAccess({ status: "idle" }, form())).resolves.toEqual({
      status: "unknown",
      message: "Enter the GitHub owner linked to this organization.",
    });
    expect(githubRequestCount).toBe(0);
  });

  test("reports a missing App installation without claiming configuration is absent", async () => {
    probeResult = { status: "not_installed" };

    await expect(checkRepositoryAccess({ status: "idle" }, form())).resolves.toEqual({
      status: "not_installed",
      message:
        "acme/repository cannot receive Postil reviews or checks because the GitHub App is not installed for acme. Postil cannot inspect configuration in this repository.",
    });
  });

  test("reports selected access", async () => {
    await expect(checkRepositoryAccess({ status: "idle" }, form())).resolves.toEqual({
      status: "selected",
      message: "acme/repository is selected for this GitHub App installation.",
      settingsUrl: "https://github.com/organizations/acme/settings/installations/42",
    });
  });

  test("reports an excluded repository without claiming configuration is absent", async () => {
    probeResult = {
      status: "not_selected",
      installation: {
        githubInstallationId: 42,
        accountLogin: "acme",
        accountType: "Organization",
      },
    };

    await expect(checkRepositoryAccess({ status: "idle" }, form())).resolves.toEqual({
      status: "not_selected",
      message:
        "acme/repository cannot receive Postil reviews or checks because it is not selected for this GitHub App installation. Postil cannot inspect configuration in this repository.",
      settingsUrl: "https://github.com/organizations/acme/settings/installations/42",
    });
  });

  test("fails closed when GitHub cannot determine selection", async () => {
    probeResult = { status: "unknown" };

    await expect(checkRepositoryAccess({ status: "idle" }, form())).resolves.toEqual({
      status: "unknown",
      message: "Repository access could not be confirmed. Try again.",
    });
  });
});

function form(owner = "acme", name = "repository"): FormData {
  const data = new FormData();
  data.set("slug", "acme");
  data.set("owner", owner);
  data.set("name", name);
  return data;
}
