import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  resolveOwnerGithubConfig,
  type OwnerConfigStore,
} from "@/lib/github/owner-config";
import { buildConfigProvenance } from "@/lib/github/contents";

const COMMIT = "a".repeat(40);
const files = new Map<string, string>();
const requests: Request[] = [];
const authorizationHeaders: Array<string | null> = [];
let failContents = false;
let snapshot: Parameters<OwnerConfigStore["saveSnapshot"]>[0] | null = null;
let installed = true;
let installedGithubRepoId = 99;
let server: ReturnType<typeof Bun.serve>;

const store: OwnerConfigStore = {
  async findInstalledRepository(_installationId, fullName) {
    return installed ? { id: 7, githubRepoId: installedGithubRepoId, fullName } : null;
  },
  async loadSnapshot() {
    return snapshot;
  },
  async saveSnapshot(value) {
    snapshot = value;
  },
  async markDegraded() {},
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(request);
      authorizationHeaders.push(request.headers.get("authorization"));
      const url = new URL(request.url);
      if (url.pathname === "/repos/acme/.github") {
        return Response.json({
          id: 99,
          full_name: "acme/.github",
          visibility: "private",
          default_branch: "trunk",
          fork: false,
          archived: false,
          owner: { id: 42, login: "acme" },
        });
      }
      if (url.pathname === "/repos/acme/.github/commits/trunk") {
        return Response.json({ sha: COMMIT });
      }
      const prefix = "/repos/acme/.github/contents/";
      if (url.pathname.startsWith(prefix)) {
        if (failContents) return new Response("unavailable", { status: 503 });
        if (url.searchParams.get("ref") !== COMMIT) return new Response("bad ref", { status: 400 });
        const path = decodeURIComponent(url.pathname.slice(prefix.length));
        const body = files.get(path);
        if (body === undefined) return new Response("not found", { status: 404 });
        return Response.json({
          type: "file",
          size: Buffer.byteLength(body),
          encoding: "base64",
          content: Buffer.from(body).toString("base64"),
        });
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
  files.clear();
  requests.length = 0;
  authorizationHeaders.length = 0;
  failContents = false;
  snapshot = null;
  installed = true;
  installedGithubRepoId = 99;
});

const input = {
  token: "installation-token",
  orgId: 1,
  githubOwnerId: 42,
  installationId: 3,
  owner: "acme",
};

describe("owner .github configuration", () => {
  test("reads only explicit files from one authenticated default-branch commit", async () => {
    files.set(".postil.yaml", "review:\n  minConfidence: 0.8\n");
    files.set(".postil/guardrails.md", "No unsafe migrations.\n");

    const resolved = await resolveOwnerGithubConfig(store, input);

    expect(resolved.status).toBe("present");
    expect(resolved.commitSha).toBe(COMMIT);
    expect(resolved.files).toEqual([".postil.yaml", ".postil/guardrails.md"]);
    expect(authorizationHeaders.every((value) => value === "Bearer installation-token")).toBe(true);
    expect(requests.filter((request) => request.url.includes("/contents/"))).toHaveLength(3);
    expect(resolved.provenance.map((entry) => entry.status)).toEqual([
      "present",
      "present",
      "absent",
    ]);
    expect(resolved.provenance.map((entry) => entry.repositoryId)).toEqual([99, 99, 99]);
  });

  test("uses the last known good snapshot on a transient GitHub failure", async () => {
    files.set(".postil/guardrails.md", "Known rule.\n");
    const fresh = await resolveOwnerGithubConfig(store, input);
    expect(fresh.stale).toBe(false);
    failContents = true;

    const degraded = await resolveOwnerGithubConfig(store, input);

    expect(degraded.status).toBe("transient");
    expect(degraded.stale).toBe(true);
    expect(degraded.config?.guardrailsMd).toBe("Known rule.\n");
    expect(degraded.provenance.every((entry) => entry.stale)).toBe(true);
  });

  test("does not make an unauthenticated public read when the source is not installed", async () => {
    installed = false;

    const resolved = await resolveOwnerGithubConfig(store, input);

    expect(resolved.status).toBe("inaccessible");
    expect(resolved.provenance.every((entry) => entry.status === "inaccessible")).toBe(true);
    expect(buildConfigProvenance([], resolved.provenance).degraded).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test("rejects a repository owned by a different GitHub account", async () => {
    const wrongOwnerServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          id: 99,
          full_name: "acme/.github",
          visibility: "public",
          default_branch: "main",
          fork: false,
          archived: false,
          owner: { id: 777, login: "acme" },
        });
      },
    });
    const original = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = `http://127.0.0.1:${wrongOwnerServer.port}`;
    try {
      const resolved = await resolveOwnerGithubConfig(store, input);
      expect(resolved.status).toBe("inaccessible");
      expect(resolved.config).toBeNull();
    } finally {
      wrongOwnerServer.stop(true);
      process.env.GITHUB_API_URL = original;
    }
  });

  test("does not reuse a snapshot after the source repository identity changes", async () => {
    files.set(".postil/guardrails.md", "Old repository rule.\n");
    await resolveOwnerGithubConfig(store, input);
    installedGithubRepoId = 100;

    const resolved = await resolveOwnerGithubConfig(store, input);

    expect(resolved.status).toBe("inaccessible");
    expect(resolved.config).toBeNull();
    expect(resolved.sourceGithubRepoId).toBe(100);
  });
});
