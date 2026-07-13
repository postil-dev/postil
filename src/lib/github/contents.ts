import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withoutModelConfig } from "@/lib/org-review-config";
import { apiBase } from "./app-auth";

/**
 * Repo-config discovery for hosted reviews.
 *
 * The CLI reads `.postil.yaml` (or `.yml`/`.json`), `.postil/guardrails.md`,
 * and `.postil/content-policy.md` from its working directory. The hosted
 * worker never checks the repo out, so without this the CLI always ran on
 * defaults and repo-level config silently did nothing. These helpers fetch
 * the config files over the contents API and materialize them into a
 * per-job working directory the CLI is spawned in.
 *
 * Config is always read from the repository's DEFAULT branch (the contents
 * API default when no ref is passed), never the PR head: a PR must not be
 * able to weaken its own gate, disable review, or inject prompt text by
 * editing `.postil/*` in the same PR. This matches the trust model of
 * `pull_request_target`-style CI config.
 */

/** Above this size a config file is ignored (and logged), not truncated. */
const MAX_CONFIG_FILE_BYTES = 64 * 1024;

/** The CLI's `.postil.yaml` discovery order, mirrored exactly. */
const CONFIG_FILE_CANDIDATES = [".postil.yaml", ".postil.yml", ".postil.json"];

const PROSE_FILES = [".postil/guardrails.md", ".postil/content-policy.md"];

export interface OrgReviewConfig {
  configYaml: string | null;
  guardrailsMd: string | null;
  contentPolicyMd: string | null;
}

export type ConfigSlot = "root" | "guardrails" | "content-policy";
export type ConfigSource = "repository" | "shared" | "organization" | "builtin";

export interface ConfigProvenanceEntry {
  slot: ConfigSlot;
  source: ConfigSource;
  path: string | null;
  /** Immutable GitHub repository ID, never the control-plane database row ID. */
  repositoryId?: number;
  repository?: string;
  commitSha?: string;
  stale?: boolean;
  status?: "present" | "absent" | "inaccessible" | "transient";
  fallback?: {
    source: "shared";
    repository?: string;
    commitSha?: string;
    stale?: boolean;
    status: "inaccessible" | "transient";
  };
}

export interface ReviewConfigProvenance {
  entries: ConfigProvenanceEntry[];
  degraded: boolean;
}

/** Return the configuration slots not supplied by the target repository. */
export function missingRepositoryConfigSlots(repoFiles: readonly string[]): ConfigSlot[] {
  const missing: ConfigSlot[] = [];
  if (!CONFIG_FILE_CANDIDATES.some((candidate) => repoFiles.includes(candidate))) {
    missing.push("root");
  }
  if (!repoFiles.includes(PROSE_FILES[0]!)) missing.push("guardrails");
  if (!repoFiles.includes(PROSE_FILES[1]!)) missing.push("content-policy");
  return missing;
}

/**
 * Fetch one file from the repo's default branch. Returns null when the file
 * does not exist or exceeds the size cap; throws on other API failures.
 */
export async function fetchRepoFile(
  token: string,
  repoFullName: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(`${apiBase()}/repos/${repoFullName}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "postil-control-plane",
    },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub GET contents ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }
  const body = await res.text();
  if (Buffer.byteLength(body) > MAX_CONFIG_FILE_BYTES) {
    console.warn(
      `repo config ${repoFullName}:${path} ignored: ${Buffer.byteLength(body)} bytes exceeds the ${MAX_CONFIG_FILE_BYTES}-byte cap`,
    );
    return null;
  }
  return body;
}

/**
 * Materialize the repo's Postil config files into `dir` so a CLI spawned
 * with `cwd: dir` discovers them exactly as it would in a local checkout.
 * Returns the paths written (repo-relative), for logging.
 *
 * Best-effort by design: a transient contents-API failure downgrades the
 * review to default config with a warning rather than failing it — the
 * review itself is the product; the config is a preference.
 */
export async function materializeRepoConfig(
  token: string,
  repoFullName: string,
  dir: string,
  options: { allowModelSettings?: boolean } = {},
): Promise<string[]> {
  const written: string[] = [];
  await mkdir(join(dir, ".postil"), { recursive: true });

  for (const candidate of CONFIG_FILE_CANDIDATES) {
    try {
      const body = await fetchRepoFile(token, repoFullName, candidate);
      if (body !== null) {
        const effectiveBody = options.allowModelSettings === false
          ? withoutModelConfig(body, candidate.endsWith(".json") ? "json" : "yaml")
          : body;
        if (effectiveBody !== null) {
          await writeFile(join(dir, candidate), effectiveBody);
          written.push(candidate);
        }
        break; // first hit wins, matching the CLI's own discovery order
      }
    } catch (err) {
      console.warn(
        `repo config fetch failed for ${repoFullName}:${candidate}, continuing with defaults: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
  }

  for (const path of PROSE_FILES) {
    try {
      const body = await fetchRepoFile(token, repoFullName, path);
      if (body !== null) {
        await writeFile(join(dir, path), body);
        written.push(path);
      }
    } catch (err) {
      console.warn(
        `repo config fetch failed for ${repoFullName}:${path}, continuing without it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return written;
}

/**
 * Fill config slots that the repository did not provide from organization
 * settings. Repo files are materialized first and always win per slot. The
 * returned paths carry an `org:` prefix so review history preserves their
 * source without changing the existing text-array column.
 */
export async function materializeOrgConfig(
  dir: string,
  repoFiles: readonly string[],
  config: OrgReviewConfig | null,
): Promise<string[]> {
  if (!config) return [];

  const written: string[] = [];
  await mkdir(join(dir, ".postil"), { recursive: true });

  if (
    config.configYaml !== null &&
    !CONFIG_FILE_CANDIDATES.some((candidate) => repoFiles.includes(candidate))
  ) {
    await writeFile(join(dir, ".postil.yaml"), config.configYaml);
    written.push("org:.postil.yaml");
  }

  const proseConfig = [
    [".postil/guardrails.md", config.guardrailsMd],
    [".postil/content-policy.md", config.contentPolicyMd],
  ] as const;
  for (const [path, body] of proseConfig) {
    if (body !== null && !repoFiles.includes(path)) {
      await writeFile(join(dir, path), body);
      written.push(`org:${path}`);
    }
  }

  return written;
}

/**
 * Fill missing repository slots from the owner `.github` snapshot. Shared
 * root config uses one explicit YAML path and can select models only in BYOK.
 */
export async function materializeSharedConfig(
  dir: string,
  repoFiles: readonly string[],
  config: OrgReviewConfig | null,
  options: { allowModelSettings?: boolean } = {},
): Promise<string[]> {
  if (!config) return [];
  const written: string[] = [];
  await mkdir(join(dir, ".postil"), { recursive: true });

  if (
    config.configYaml !== null &&
    !CONFIG_FILE_CANDIDATES.some((candidate) => repoFiles.includes(candidate))
  ) {
    const body = options.allowModelSettings === false
      ? withoutModelConfig(config.configYaml, "yaml")
      : config.configYaml;
    if (body !== null) {
      await writeFile(join(dir, ".postil.yaml"), body);
      written.push("shared:.postil.yaml");
    }
  }
  for (const [path, body] of [
    [".postil/guardrails.md", config.guardrailsMd],
    [".postil/content-policy.md", config.contentPolicyMd],
  ] as const) {
    if (body !== null && !repoFiles.includes(path)) {
      await writeFile(join(dir, path), body);
      written.push(`shared:${path}`);
    }
  }
  return written;
}

/** Return one provenance row per effective slot, including built-in fallbacks. */
export function buildConfigProvenance(
  configFiles: readonly string[],
  shared: readonly ConfigProvenanceEntry[] = [],
  repository?: { id: number; fullName: string },
): ReviewConfigProvenance {
  const slots: Array<{ slot: ConfigSlot; repositoryFiles: readonly string[]; path: string }> = [
    { slot: "root", repositoryFiles: CONFIG_FILE_CANDIDATES, path: ".postil.yaml" },
    { slot: "guardrails", repositoryFiles: [PROSE_FILES[0]!], path: PROSE_FILES[0]! },
    { slot: "content-policy", repositoryFiles: [PROSE_FILES[1]!], path: PROSE_FILES[1]! },
  ];
  const entries = slots.map(({ slot, repositoryFiles, path }) => {
    const repositoryPath = repositoryFiles.find((candidate) => configFiles.includes(candidate));
    if (repositoryPath) {
      return {
        slot,
        source: "repository" as const,
        path: repositoryPath,
        ...(repository ? { repositoryId: repository.id, repository: repository.fullName } : {}),
      };
    }
    const sharedEntry = shared.find((entry) => entry.slot === slot);
    if (sharedEntry?.source === "shared" && configFiles.includes(`shared:${path}`)) {
      return sharedEntry;
    }
    const fallback =
      sharedEntry?.status === "inaccessible" || sharedEntry?.status === "transient"
        ? {
            source: "shared" as const,
            repository: sharedEntry.repository,
            commitSha: sharedEntry.commitSha,
            stale: sharedEntry.stale,
            status: sharedEntry.status,
          }
        : undefined;
    if (configFiles.includes(`org:${path}`)) {
      return { slot, source: "organization" as const, path, ...(fallback ? { fallback } : {}) };
    }
    return {
      slot,
      source: "builtin" as const,
      path: null,
      ...(fallback ? { fallback } : {}),
    };
  });
  return {
    entries,
    degraded: entries.some(
      (entry) =>
        entry.stale === true ||
        entry.status === "inaccessible" ||
        entry.status === "transient" ||
        entry.fallback !== undefined,
    ),
  };
}
