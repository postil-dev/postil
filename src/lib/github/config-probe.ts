import { inArray } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { apiBase, getInstallationToken } from "./app-auth";
import { fetchRepoFile } from "./contents";

export const CONFIG_PROBE_TTL_MS = 15 * 60 * 1000;
export const CONFIG_PROBE_CONCURRENCY = 4;
export const CONFIG_PROBE_TIMEOUT_MS = 10_000;

const ROOT_CONFIG_FILES = [".postil.yaml", ".postil.yml", ".postil.json"] as const;
const NESTED_CONFIG_FILES = ["guardrails.md", "content-policy.md"] as const;
const ALL_CONFIG_FILES = [
  ...ROOT_CONFIG_FILES,
  ...NESTED_CONFIG_FILES.map((file) => `.postil/${file}`),
] as const;

interface GithubContentEntry {
  name: string;
  path: string;
  type: "file" | "dir" | string;
}

export interface RepoConfigProbe {
  repositoryId: number;
  probedAt: Date;
  ok: boolean;
  files: string[];
}

export interface RepoToProbe {
  repositoryId: number;
  githubInstallationId: number;
  fullName: string;
}

export interface ProbeCacheStore {
  load(repositoryIds: readonly number[]): Promise<RepoConfigProbe[]>;
  saveSuccess(probe: RepoConfigProbe): Promise<void>;
  saveFailure(repositoryId: number, attemptedAt: Date): Promise<void>;
}

export interface RefreshProbeOptions {
  force?: boolean;
  now?: Date;
  probe?: (repo: RepoToProbe) => Promise<string[]>;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "postil-control-plane",
  };
}

async function listDirectory(
  token: string,
  repoFullName: string,
  path: string,
  signal?: AbortSignal,
): Promise<GithubContentEntry[] | null> {
  const suffix = path ? `/${path}` : "/";
  const res = await fetch(`${apiBase()}/repos/${repoFullName}/contents${suffix}`, {
    headers: githubHeaders(token),
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub GET contents listing ${path || "/"} failed: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return null;
  return data.filter(
    (entry): entry is GithubContentEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as GithubContentEntry).name === "string" &&
      typeof (entry as GithubContentEntry).path === "string" &&
      typeof (entry as GithubContentEntry).type === "string",
  );
}

async function fallbackFileChecks(
  token: string,
  repoFullName: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    if ((await fetchRepoFile(token, repoFullName, path, signal)) !== null) found.push(path);
  }
  return found;
}

/** Probe config paths on a repository's default branch using at most two listings. */
export async function probeRepoConfigFiles(
  githubInstallationId: number,
  repoFullName: string,
): Promise<string[]> {
  const signal = AbortSignal.timeout(CONFIG_PROBE_TIMEOUT_MS);
  const token = await getInstallationToken(githubInstallationId, signal);
  return probeRepoConfigFilesWithToken(token, repoFullName, signal);
}

/** Exported separately so the contents-API behavior can be tested without app credentials. */
export async function probeRepoConfigFilesWithToken(
  token: string,
  repoFullName: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const root = await listDirectory(token, repoFullName, "", signal);
  if (!root || root.length === 0) {
    return fallbackFileChecks(token, repoFullName, ALL_CONFIG_FILES, signal);
  }

  const found = ROOT_CONFIG_FILES.filter((path) =>
    root.some((entry) => entry.type === "file" && entry.name === path),
  );
  if (!root.some((entry) => entry.type === "dir" && entry.name === ".postil")) {
    return [...found];
  }

  const nested = await listDirectory(token, repoFullName, ".postil", signal);
  if (!nested || nested.length === 0) {
    return [
      ...found,
      ...(await fallbackFileChecks(
        token,
        repoFullName,
        NESTED_CONFIG_FILES.map((file) => `.postil/${file}`),
        signal,
      )),
    ];
  }
  return [
    ...found,
    ...NESTED_CONFIG_FILES.filter((name) =>
      nested.some((entry) => entry.type === "file" && entry.name === name),
    ).map((name) => `.postil/${name}`),
  ];
}

export function createDbProbeCacheStore(db: Database): ProbeCacheStore {
  return {
    async load(repositoryIds) {
      if (repositoryIds.length === 0) return [];
      return db
        .select()
        .from(schema.repoConfigProbes)
        .where(inArray(schema.repoConfigProbes.repositoryId, [...repositoryIds]));
    },
    async saveSuccess(probe) {
      await db
        .insert(schema.repoConfigProbes)
        .values(probe)
        .onConflictDoUpdate({
          target: schema.repoConfigProbes.repositoryId,
          set: { probedAt: probe.probedAt, ok: true, files: probe.files },
        });
    },
    async saveFailure(repositoryId, attemptedAt) {
      await db
        .insert(schema.repoConfigProbes)
        .values({ repositoryId, probedAt: attemptedAt, ok: false, files: [] })
        .onConflictDoUpdate({
          target: schema.repoConfigProbes.repositoryId,
          // Preserve the last known files and successful probe time. Leaving an
          // old timestamp makes the next page load retry a transient failure.
          set: { ok: false },
        });
    },
  };
}

/**
 * Refresh stale/missing cache rows and return the resulting snapshots. Work is
 * bounded to four GitHub probes at once. A forced refresh bypasses the TTL.
 */
export async function refreshRepoConfigProbeCache(
  store: ProbeCacheStore,
  repos: readonly RepoToProbe[],
  options: RefreshProbeOptions = {},
): Promise<RepoConfigProbe[]> {
  const now = options.now ?? new Date();
  const probe = options.probe ?? ((repo) =>
    probeRepoConfigFiles(repo.githubInstallationId, repo.fullName));
  const cached = await store.load(repos.map((repo) => repo.repositoryId));
  const byId = new Map(cached.map((row) => [row.repositoryId, row]));
  const stale = repos.filter((repo) => {
    const row = byId.get(repo.repositoryId);
    return options.force || !row || now.getTime() - row.probedAt.getTime() >= CONFIG_PROBE_TTL_MS;
  });

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(CONFIG_PROBE_CONCURRENCY, stale.length) },
    async () => {
      while (cursor < stale.length) {
        const repo = stale[cursor++];
        if (!repo) break;
        try {
          const files = await probe(repo);
          const saved = { repositoryId: repo.repositoryId, probedAt: now, ok: true, files };
          await store.saveSuccess(saved);
          byId.set(repo.repositoryId, saved);
        } catch {
          await store.saveFailure(repo.repositoryId, now);
          const previous = byId.get(repo.repositoryId);
          byId.set(
            repo.repositoryId,
            previous ? { ...previous, ok: false } : {
              repositoryId: repo.repositoryId,
              probedAt: now,
              ok: false,
              files: [],
            },
          );
        }
      }
    },
  );
  await Promise.all(workers);

  return repos.flatMap((repo) => {
    const row = byId.get(repo.repositoryId);
    return row ? [row] : [];
  });
}

export async function getRepoConfigProbes(
  db: Database,
  repos: readonly RepoToProbe[],
  options: RefreshProbeOptions = {},
): Promise<RepoConfigProbe[]> {
  return refreshRepoConfigProbeCache(createDbProbeCacheStore(db), repos, options);
}
