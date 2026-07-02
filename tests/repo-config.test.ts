import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchRepoFile, materializeRepoConfig } from "@/lib/github/contents";

/**
 * Serves a fake GitHub contents API so the helpers are exercised over real
 * HTTP (headers, status codes, raw media type) without the network.
 */
const files = new Map<string, string>();
const requested: string[] = [];
let failWith500 = new Set<string>();
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const prefix = "/repos/acme/widgets/contents/";
      if (!url.pathname.startsWith(prefix)) return new Response("not found", { status: 404 });
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      requested.push(path);
      if (failWith500.has(path)) return new Response("boom", { status: 500 });
      const body = files.get(path);
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { status: 200 });
    },
  });
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  delete process.env.GITHUB_API_URL;
});

beforeEach(() => {
  files.clear();
  requested.length = 0;
  failWith500 = new Set();
});

describe("fetchRepoFile", () => {
  test("returns file contents on 200", async () => {
    files.set(".postil.yaml", "minConfidence: 0.8\n");
    expect(await fetchRepoFile("tok", "acme/widgets", ".postil.yaml")).toBe(
      "minConfidence: 0.8\n",
    );
  });

  test("returns null on 404", async () => {
    expect(await fetchRepoFile("tok", "acme/widgets", ".postil.yaml")).toBeNull();
  });

  test("throws on other API failures", async () => {
    failWith500 = new Set([".postil.yaml"]);
    await expect(fetchRepoFile("tok", "acme/widgets", ".postil.yaml")).rejects.toThrow(
      /HTTP 500/,
    );
  });

  test("ignores files over the size cap", async () => {
    files.set(".postil/guardrails.md", "x".repeat(64 * 1024 + 1));
    expect(await fetchRepoFile("tok", "acme/widgets", ".postil/guardrails.md")).toBeNull();
  });
});

describe("materializeRepoConfig", () => {
  test("writes config and prose files into the work dir", async () => {
    files.set(".postil.yaml", "minConfidence: 0.8\n");
    files.set(".postil/guardrails.md", "No new deps without approval.\n");
    files.set(".postil/content-policy.md", "No marketing superlatives.\n");
    const dir = await mkdtemp(join(tmpdir(), "postil-config-"));

    const written = await materializeRepoConfig("tok", "acme/widgets", dir);

    expect(written.sort()).toEqual([
      ".postil.yaml",
      ".postil/content-policy.md",
      ".postil/guardrails.md",
    ]);
    expect(await readFile(join(dir, ".postil.yaml"), "utf8")).toBe("minConfidence: 0.8\n");
    expect(await readFile(join(dir, ".postil", "content-policy.md"), "utf8")).toBe(
      "No marketing superlatives.\n",
    );
  });

  test("first config candidate wins, later ones are not fetched", async () => {
    files.set(".postil.yaml", "enabled: true\n");
    files.set(".postil.yml", "enabled: false\n");
    const dir = await mkdtemp(join(tmpdir(), "postil-config-"));

    const written = await materializeRepoConfig("tok", "acme/widgets", dir);

    expect(written).toContain(".postil.yaml");
    expect(requested).not.toContain(".postil.yml");
  });

  test("falls back through config candidates on 404", async () => {
    files.set(".postil.json", '{"enabled": true}');
    const dir = await mkdtemp(join(tmpdir(), "postil-config-"));

    const written = await materializeRepoConfig("tok", "acme/widgets", dir);

    expect(written).toEqual([".postil.json"]);
    expect(requested).toContain(".postil.yaml");
    expect(requested).toContain(".postil.yml");
  });

  test("a repo with no config writes nothing and does not throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postil-config-"));
    expect(await materializeRepoConfig("tok", "acme/widgets", dir)).toEqual([]);
    expect(await readdir(join(dir, ".postil"))).toEqual([]);
  });

  test("transient API failure degrades to defaults instead of throwing", async () => {
    failWith500 = new Set([".postil.yaml", ".postil/guardrails.md"]);
    files.set(".postil/content-policy.md", "Rule.\n");
    const dir = await mkdtemp(join(tmpdir(), "postil-config-"));

    const written = await materializeRepoConfig("tok", "acme/widgets", dir);

    // The failed fetches are skipped with a warning; the healthy one lands.
    expect(written).toEqual([".postil/content-policy.md"]);
  });
});
