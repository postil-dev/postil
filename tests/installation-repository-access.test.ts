import { afterEach, describe, expect, test } from "bun:test";

import {
  checkInstallationRepositoryAccess,
  MAX_INSTALLATION_REPOSITORY_PAGES,
} from "@/lib/github/installation-sync";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
