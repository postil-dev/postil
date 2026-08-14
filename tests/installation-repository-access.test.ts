import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let installationTokenCalls: number[] = [];

mock.module("@/lib/github/app-auth", () => ({
  apiBase: () => "https://api.github.test",
  buildAppJwt: () => "app-token",
  getAppJwt: () => "app-token",
  getInstallationToken: async (installationId: number) => {
    installationTokenCalls.push(installationId);
    return "installation-token";
  },
  normalizePrivateKey: (value: string) => value,
}));

import {
  checkGithubAppRepositoryAccess,
  checkInstallationRepositoryAccess,
  MAX_INSTALLATION_REPOSITORY_PAGES,
} from "@/lib/github/installation-sync";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  installationTokenCalls = [];
});

describe("checkInstallationRepositoryAccess", () => {
  test("finds a selected repository on a later page", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      const page = new URL(String(input)).searchParams.get("page");
      return Response.json({
        repositories:
          page === "1"
            ? Array.from({ length: 100 }, (_, index) => ({ full_name: `acme/repo-${index}` }))
            : [{ full_name: "acme/selected" }],
      });
    }) as typeof fetch;

    await expect(checkInstallationRepositoryAccess("token", "Acme/Selected")).resolves.toBe(
      "selected",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("per_page=100&page=2");
  });

  test("reports not selected after a complete listing", async () => {
    globalThis.fetch = (async () => Response.json({ repositories: [] })) as unknown as typeof fetch;

    await expect(checkInstallationRepositoryAccess("token", "acme/missing")).resolves.toBe(
      "not_selected",
    );
  });

  test("rejects an incomplete API response", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    await expect(checkInstallationRepositoryAccess("token", "acme/repository")).rejects.toThrow(
      "installation repository listing failed with HTTP 503",
    );
  });

  test("reports unknown at the pagination boundary", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      return Response.json({
        repositories: Array.from({ length: 100 }, (_, index) => ({ full_name: `acme/repo-${index}` })),
      });
    }) as unknown as typeof fetch;

    await expect(checkInstallationRepositoryAccess("token", "acme/missing")).resolves.toBe(
      "unknown",
    );
    expect(requestCount).toBe(MAX_INSTALLATION_REPOSITORY_PAGES);
  });
});

describe("checkGithubAppRepositoryAccess", () => {
  test("uses an App JWT lookup and installation token selection listing for an organization", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") });
      if (url.endsWith("/orgs/acme/installation")) {
        return Response.json({
          id: 42,
          suspended_at: null,
          account: { id: 100, login: "acme", type: "Organization" },
        });
      }
      if (url.includes("/installation/repositories")) {
        return Response.json({ repositories: [{ full_name: "acme/repository" }] });
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;

    await expect(checkGithubAppRepositoryAccess("acme", "repository", 100)).resolves.toEqual({
      status: "selected",
      installation: {
        githubInstallationId: 42,
        accountLogin: "acme",
        accountType: "Organization",
      },
    });
    expect(installationTokenCalls).toEqual([42]);
    expect(requests).toEqual([
      {
        url: "https://api.github.test/orgs/acme/installation",
        authorization: "Bearer app-token",
      },
      {
        url: "https://api.github.test/installation/repositories?per_page=100&page=1",
        authorization: "Bearer installation-token",
      },
    ]);
  });

  test("reports not installed only after both organization and user lookups return 404", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await expect(checkGithubAppRepositoryAccess("acme", "repository", 100)).resolves.toEqual({
      status: "not_installed",
    });
    expect(requests).toEqual([
      "https://api.github.test/orgs/acme/installation",
      "https://api.github.test/users/acme/installation",
    ]);
    expect(installationTokenCalls).toEqual([]);
  });

  test("uses the user installation lookup when the owner is a personal account", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/orgs/alice/installation")) return new Response(null, { status: 404 });
      if (url.endsWith("/users/alice/installation")) {
        return Response.json({
          id: 43,
          suspended_at: null,
          account: { id: 101, login: "alice", type: "User" },
        });
      }
      return Response.json({ repositories: [] });
    }) as typeof fetch;

    await expect(checkGithubAppRepositoryAccess("alice", "repository", 101)).resolves.toMatchObject({
      status: "not_selected",
      installation: { githubInstallationId: 43, accountType: "User" },
    });
    expect(requests).toHaveLength(3);
    expect(installationTokenCalls).toEqual([43]);
  });

  test("fails closed for lookup failures, suspended installations, and malformed installation responses", async () => {
    const responses = [
      new Response(null, { status: 503 }),
      Response.json({
        id: 42,
        suspended_at: "2026-08-14T00:00:00Z",
        account: { id: 100, login: "acme", type: "Organization" },
      }),
      Response.json({
        id: "42",
        suspended_at: null,
        account: { id: 100, login: "acme", type: "Organization" },
      }),
      Response.json({
        id: 42,
        account: { id: 100, login: "acme", type: "Organization" },
      }),
    ];

    for (const response of responses) {
      globalThis.fetch = (async () =>
        response.clone()) as unknown as typeof fetch;
      await expect(
        checkGithubAppRepositoryAccess("acme", "repository", 100),
      ).resolves.toEqual({ status: "unknown" });
    }
    expect(installationTokenCalls).toEqual([]);
  });

  test("rejects an installation whose immutable owner identity does not match the organization", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        id: 42,
        suspended_at: null,
        account: { id: 101, login: "acme", type: "Organization" },
      })) as unknown as typeof fetch;

    await expect(
      checkGithubAppRepositoryAccess("acme", "repository", 100),
    ).resolves.toEqual({ status: "unknown" });
    expect(installationTokenCalls).toEqual([]);
  });

  test("fails closed when a complete installation listing cannot be established", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/orgs/acme/installation")) {
        return Response.json({
          id: 42,
          suspended_at: null,
          account: { id: 100, login: "acme", type: "Organization" },
        });
      }
      return new Response(null, { status: 503 });
    }) as typeof fetch;

    await expect(checkGithubAppRepositoryAccess("acme", "repository", 100)).resolves.toEqual({
      status: "unknown",
    });
    expect(installationTokenCalls).toEqual([42]);
  });

  test("preserves pagination uncertainty as unknown", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/orgs/acme/installation")) {
        return Response.json({
          id: 42,
          suspended_at: null,
          account: { id: 100, login: "acme", type: "Organization" },
        });
      }
      return Response.json({
        repositories: Array.from({ length: 100 }, (_, index) => ({
          full_name: `acme/repository-${index}`,
        })),
      });
    }) as typeof fetch;

    await expect(checkGithubAppRepositoryAccess("acme", "repository", 100)).resolves.toMatchObject({
      status: "unknown",
      installation: { githubInstallationId: 42 },
    });
    expect(installationTokenCalls).toEqual([42]);
  });
});
