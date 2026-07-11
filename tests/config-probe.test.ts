import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  CONFIG_PROBE_TTL_MS,
  probeRepoConfigFilesWithToken,
  refreshRepoConfigProbeCache,
  type ProbeCacheStore,
  type RepoConfigProbe,
} from "@/lib/github/config-probe";

function memoryStore(seed: RepoConfigProbe[] = []) {
  const rows = new Map(seed.map((row) => [row.repositoryId, row]));
  const store: ProbeCacheStore = {
    async load(ids) {
      return ids.flatMap((id) => {
        const row = rows.get(id);
        return row ? [row] : [];
      });
    },
    async saveSuccess(row) {
      rows.set(row.repositoryId, row);
    },
    async saveFailure(repositoryId, attemptedAt) {
      const previous = rows.get(repositoryId);
      rows.set(
        repositoryId,
        previous
          ? { ...previous, ok: false }
          : { repositoryId, probedAt: attemptedAt, ok: false, files: [] },
      );
    },
  };
  return { store, rows };
}

const repo = { repositoryId: 1, githubInstallationId: 22, fullName: "acme/widgets" };

describe("repo config probe cache", () => {
  test("skips a probe within 15 minutes, refreshes at the TTL, and force bypasses it", async () => {
    const now = new Date("2026-07-11T12:00:00Z");
    const { store } = memoryStore([
      {
        repositoryId: 1,
        probedAt: new Date(now.getTime() - CONFIG_PROBE_TTL_MS + 1),
        ok: true,
        files: [".postil.yaml"],
      },
    ]);
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return [".postil.json"];
    };

    expect((await refreshRepoConfigProbeCache(store, [repo], { now, probe }))[0]!.files)
      .toEqual([".postil.yaml"]);
    expect(calls).toBe(0);

    const afterTtl = new Date(now.getTime() + 1);
    expect(
      (await refreshRepoConfigProbeCache(store, [repo], { now: afterTtl, probe }))[0]!.files,
    ).toEqual([".postil.json"]);
    expect(calls).toBe(1);

    await refreshRepoConfigProbeCache(store, [repo], { now: afterTtl, force: true, probe });
    expect(calls).toBe(2);
  });

  test("a failed refresh marks unverified while preserving files and probe time", async () => {
    const oldTime = new Date("2026-07-10T12:00:00Z");
    const { store, rows } = memoryStore([
      { repositoryId: 1, probedAt: oldTime, ok: true, files: [".postil.yaml"] },
    ]);

    await refreshRepoConfigProbeCache(store, [repo], {
      now: new Date("2026-07-11T12:00:00Z"),
      probe: async () => {
        throw new Error("GitHub unavailable");
      },
    });

    expect(rows.get(1)).toEqual({
      repositoryId: 1,
      probedAt: oldTime,
      ok: false,
      files: [".postil.yaml"],
    });
  });

  test("caps concurrent GitHub probes at four", async () => {
    const { store } = memoryStore();
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repos = Array.from({ length: 9 }, (_, index) => ({
      repositoryId: index + 1,
      githubInstallationId: 22,
      fullName: `acme/repo-${index + 1}`,
    }));
    const refreshing = refreshRepoConfigProbeCache(store, repos, {
      probe: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return [];
      },
    });
    await Bun.sleep(0);
    expect(peak).toBe(4);
    release!();
    await refreshing;
    expect(peak).toBe(4);
  });
});

describe("probeRepoConfigFiles", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests: string[];
  let mode: "listings" | "fallback";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push(`${req.method} ${url.pathname}`);
        if (url.pathname === "/repos/acme/widgets/contents/") {
          return mode === "fallback"
            ? Response.json([])
            : Response.json([
                { name: ".postil.yml", path: ".postil.yml", type: "file" },
                { name: ".postil", path: ".postil", type: "dir" },
              ]);
        }
        if (url.pathname === "/repos/acme/widgets/contents/.postil") {
          return Response.json([
            {
              name: "guardrails.md",
              path: ".postil/guardrails.md",
              type: "file",
            },
          ]);
        }
        if (mode === "fallback" && url.pathname.endsWith("/.postil.json")) {
          return new Response("{}", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.GITHUB_API_URL = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    delete process.env.GITHUB_API_URL;
  });

  beforeEach(() => {
    requests = [];
    mode = "listings";
  });

  test("uses root and .postil listings", async () => {
    expect(await probeRepoConfigFilesWithToken("token", "acme/widgets")).toEqual([
      ".postil.yml",
      ".postil/guardrails.md",
    ]);
    expect(requests.filter((request) => request.includes("/contents"))).toHaveLength(2);
  });

  test("falls back to path fetches when the root listing is empty", async () => {
    mode = "fallback";
    expect(await probeRepoConfigFilesWithToken("token", "acme/widgets")).toEqual([
      ".postil.json",
    ]);
    expect(requests).toContain("GET /repos/acme/widgets/contents/.postil.json");
  });

  test("honors the probe abort signal", async () => {
    await expect(
      probeRepoConfigFilesWithToken("token", "acme/widgets", AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
