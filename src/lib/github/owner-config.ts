import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import type { ConfigProvenanceEntry, ConfigSlot, OrgReviewConfig } from "./contents";
import { apiBase } from "./app-auth";

const SHARED_PATHS = [
  ["root", ".postil.yaml", "configYaml"],
  ["guardrails", ".postil/guardrails.md", "guardrailsMd"],
  ["content-policy", ".postil/content-policy.md", "contentPolicyMd"],
] as const;
const MAX_CONFIG_FILE_BYTES = 64 * 1024;
const GITHUB_CONFIG_TIMEOUT_MS = 10_000;

type ResolutionStatus = "present" | "absent" | "inaccessible" | "transient";

export interface OwnerConfigResolution {
  config: OrgReviewConfig | null;
  files: string[];
  status: ResolutionStatus;
  stale: boolean;
  sourceRepositoryId: number | null;
  sourceGithubRepoId: number | null;
  sourceFullName: string;
  visibility: string | null;
  defaultBranch: string | null;
  commitSha: string | null;
  provenance: ConfigProvenanceEntry[];
}

interface RepositoryMetadata {
  id: number;
  full_name: string;
  visibility: string;
  default_branch: string;
  fork: boolean;
  archived: boolean;
  owner: { id: number; login: string };
}

interface Snapshot {
  orgId: number;
  sourceRepositoryId: number | null;
  sourceGithubRepoId: number;
  sourceFullName: string;
  visibility: string;
  defaultBranch: string;
  commitSha: string;
  configYaml: string | null;
  guardrailsMd: string | null;
  contentPolicyMd: string | null;
  files: string[];
  loadedFiles: string[];
}

export interface OwnerConfigStore {
  findInstalledRepository(installationId: number, fullName: string): Promise<{
    id: number;
    githubRepoId: number;
    fullName: string;
  } | null>;
  loadSnapshot(orgId: number): Promise<Snapshot | null>;
  saveSnapshot(snapshot: Snapshot): Promise<void>;
  markDegraded(orgId: number, status: "inaccessible" | "transient"): Promise<void>;
  deleteSnapshot(orgId: number): Promise<void>;
}

export function createOwnerConfigStore(db: Database): OwnerConfigStore {
  return {
    async findInstalledRepository(installationId, fullName) {
      return (
        await db
          .select({
            id: schema.repositories.id,
            githubRepoId: schema.repositories.githubRepoId,
            fullName: schema.repositories.fullName,
          })
          .from(schema.repositories)
          .where(
            and(
              eq(schema.repositories.installationId, installationId),
              sql`lower(${schema.repositories.fullName}) = lower(${fullName})`,
            ),
          )
          .limit(1)
      )[0] ?? null;
    },
    async loadSnapshot(orgId) {
      return (
        await db
          .select({
            orgId: schema.orgConfigSnapshots.orgId,
            sourceRepositoryId: schema.orgConfigSnapshots.sourceRepositoryId,
            sourceGithubRepoId: schema.orgConfigSnapshots.sourceGithubRepoId,
            sourceFullName: schema.orgConfigSnapshots.sourceFullName,
            visibility: schema.orgConfigSnapshots.visibility,
            defaultBranch: schema.orgConfigSnapshots.defaultBranch,
            commitSha: schema.orgConfigSnapshots.commitSha,
            configYaml: schema.orgConfigSnapshots.configYaml,
            guardrailsMd: schema.orgConfigSnapshots.guardrailsMd,
            contentPolicyMd: schema.orgConfigSnapshots.contentPolicyMd,
            files: schema.orgConfigSnapshots.files,
            loadedFiles: schema.orgConfigSnapshots.loadedFiles,
          })
          .from(schema.orgConfigSnapshots)
          .where(eq(schema.orgConfigSnapshots.orgId, orgId))
          .limit(1)
      )[0] ?? null;
    },
    async saveSnapshot(snapshot) {
      const now = new Date();
      await db
        .insert(schema.orgConfigSnapshots)
        .values({ ...snapshot, stale: false, lastError: null, fetchedAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.orgConfigSnapshots.orgId,
          set: { ...snapshot, stale: false, lastError: null, fetchedAt: now, updatedAt: now },
        });
    },
    async markDegraded(orgId, status) {
      await db
        .update(schema.orgConfigSnapshots)
        .set({ stale: true, lastError: status, updatedAt: new Date() })
        .where(eq(schema.orgConfigSnapshots.orgId, orgId));
    },
    async deleteSnapshot(orgId) {
      await db
        .delete(schema.orgConfigSnapshots)
        .where(eq(schema.orgConfigSnapshots.orgId, orgId));
    },
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "postil-control-plane",
  };
}

class GithubConfigError extends Error {
  constructor(readonly status: "inaccessible" | "transient", message: string) {
    super(message);
  }
}

async function githubJson(token: string, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(GITHUB_CONFIG_TIMEOUT_MS),
    });
  } catch {
    throw new GithubConfigError("transient", "GitHub request failed");
  }
  if (!response.ok) {
    throw new GithubConfigError(
      githubFailureStatus(response),
      `GitHub request failed with HTTP ${response.status}`,
    );
  }
  return response.json();
}

export function githubFailureStatus(response: Response): "inaccessible" | "transient" {
  if (
    response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after"))
  ) {
    return "transient";
  }
  if (
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    return "transient";
  }
  return "inaccessible";
}

async function fetchMetadata(token: string, fullName: string): Promise<RepositoryMetadata> {
  const value = (await githubJson(token, `/repos/${fullName}`)) as Partial<RepositoryMetadata>;
  if (
    typeof value.id !== "number" ||
    typeof value.full_name !== "string" ||
    typeof value.visibility !== "string" ||
    typeof value.default_branch !== "string" ||
    typeof value.fork !== "boolean" ||
    typeof value.archived !== "boolean" ||
    !value.owner ||
    typeof value.owner.id !== "number" ||
    typeof value.owner.login !== "string"
  ) {
    throw new GithubConfigError("transient", "GitHub repository metadata was invalid");
  }
  return value as RepositoryMetadata;
}

async function fetchCommitSha(token: string, fullName: string, branch: string): Promise<string> {
  const value = (await githubJson(
    token,
    `/repos/${fullName}/commits/${encodeURIComponent(branch)}`,
  )) as { sha?: unknown };
  if (typeof value.sha !== "string" || !/^[0-9a-f]{40}$/i.test(value.sha)) {
    throw new GithubConfigError("transient", "GitHub default branch commit was invalid");
  }
  return value.sha;
}

async function fetchFileAtCommit(
  token: string,
  fullName: string,
  path: string,
  commitSha: string,
): Promise<string | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await fetch(
      `${apiBase()}/repos/${fullName}/contents/${encodedPath}?ref=${commitSha}`,
      {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(GITHUB_CONFIG_TIMEOUT_MS),
      },
    );
  } catch {
    throw new GithubConfigError("transient", "GitHub contents request failed");
  }
  if (response.status === 404) {
    throw new GithubConfigError("inaccessible", `Shared config path ${path} disappeared`);
  }
  if (!response.ok) {
    throw new GithubConfigError(
      githubFailureStatus(response),
      `GitHub contents request failed with HTTP ${response.status}`,
    );
  }
  const value = (await response.json()) as {
    type?: unknown;
    size?: unknown;
    encoding?: unknown;
    content?: unknown;
  };
  if (value.type !== "file") {
    throw new GithubConfigError("inaccessible", `Shared config path ${path} is not a file`);
  }
  if (typeof value.size !== "number" || value.size > MAX_CONFIG_FILE_BYTES) {
    throw new GithubConfigError("inaccessible", `Shared config path ${path} exceeds the size cap`);
  }
  if (value.encoding !== "base64" || typeof value.content !== "string") {
    throw new GithubConfigError("transient", `Shared config path ${path} has no inline content`);
  }
  const body = Buffer.from(value.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (Buffer.byteLength(body) !== value.size) {
    throw new GithubConfigError("transient", `Shared config path ${path} has invalid content`);
  }
  return body;
}

interface GithubContentEntry {
  name: string;
  type: string;
}

async function listDirectoryAtCommit(
  token: string,
  fullName: string,
  path: string,
  commitSha: string,
): Promise<GithubContentEntry[]> {
  const suffix = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  const value = await githubJson(
    token,
    `/repos/${fullName}/contents${suffix}?ref=${commitSha}`,
  );
  if (!Array.isArray(value)) {
    throw new GithubConfigError("inaccessible", `Shared config directory ${path || "/"} is invalid`);
  }
  return value.filter(
    (entry): entry is GithubContentEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as GithubContentEntry).name === "string" &&
      typeof (entry as GithubContentEntry).type === "string",
  );
}

async function discoverSharedPaths(
  token: string,
  fullName: string,
  commitSha: string,
): Promise<Set<string>> {
  const found = new Set<string>();
  const root = await listDirectoryAtCommit(token, fullName, "", commitSha);
  const rootConfig = root.find((entry) => entry.name === ".postil.yaml");
  if (rootConfig) {
    if (rootConfig.type !== "file") {
      throw new GithubConfigError("inaccessible", "Shared root config is not a file");
    }
    found.add(".postil.yaml");
  }
  const postilDirectory = root.find((entry) => entry.name === ".postil");
  if (!postilDirectory) return found;
  if (postilDirectory.type !== "dir") {
    throw new GithubConfigError("inaccessible", "Shared .postil path is not a directory");
  }
  const nested = await listDirectoryAtCommit(token, fullName, ".postil", commitSha);
  for (const name of ["guardrails.md", "content-policy.md"]) {
    const entry = nested.find((candidate) => candidate.name === name);
    if (!entry) continue;
    if (entry.type !== "file") {
      throw new GithubConfigError("inaccessible", `Shared config path .postil/${name} is not a file`);
    }
    found.add(`.postil/${name}`);
  }
  return found;
}

function fromSnapshot(
  snapshot: Snapshot,
  status: "inaccessible" | "transient",
): OwnerConfigResolution {
  return {
    config: {
      configYaml: snapshot.configYaml,
      guardrailsMd: snapshot.guardrailsMd,
      contentPolicyMd: snapshot.contentPolicyMd,
    },
    files: snapshot.files,
    status,
    stale: true,
    sourceRepositoryId: snapshot.sourceRepositoryId,
    sourceGithubRepoId: snapshot.sourceGithubRepoId,
    sourceFullName: snapshot.sourceFullName,
    visibility: snapshot.visibility,
    defaultBranch: snapshot.defaultBranch,
    commitSha: snapshot.commitSha,
    provenance: provenance(snapshot, status, true),
  };
}

function provenance(
  snapshot: Pick<Snapshot, "sourceGithubRepoId" | "sourceFullName" | "commitSha" | "files">,
  status: ResolutionStatus,
  stale: boolean,
): ConfigProvenanceEntry[] {
  return SHARED_PATHS.map(([slot, path]) => ({
    slot: slot as ConfigSlot,
    source: "shared",
    path: snapshot.files.includes(path) ? path : null,
    repositoryId: snapshot.sourceGithubRepoId,
    repository: snapshot.sourceFullName,
    commitSha: snapshot.commitSha,
    stale,
    status: status === "present" || status === "absent"
      ? (snapshot.files.includes(path) ? "present" : "absent")
      : status,
  }));
}

function snapshotConfig(snapshot: Snapshot): OrgReviewConfig {
  return {
    configYaml: snapshot.configYaml,
    guardrailsMd: snapshot.guardrailsMd,
    contentPolicyMd: snapshot.contentPolicyMd,
  };
}

function requiredPaths(slots: readonly ConfigSlot[]): string[] {
  const required = new Set(slots);
  return SHARED_PATHS
    .filter(([slot]) => required.has(slot as ConfigSlot))
    .map(([, path]) => path);
}

function snapshotHasRequiredContent(snapshot: Snapshot, paths: readonly string[]): boolean {
  return paths.every(
    (path) => !snapshot.files.includes(path) || snapshot.loadedFiles.includes(path),
  );
}

function freshResolution(snapshot: Snapshot): OwnerConfigResolution {
  const status = snapshot.files.length > 0 ? "present" : "absent";
  return {
    config: snapshotConfig(snapshot),
    files: snapshot.files,
    status,
    stale: false,
    sourceRepositoryId: snapshot.sourceRepositoryId,
    sourceGithubRepoId: snapshot.sourceGithubRepoId,
    sourceFullName: snapshot.sourceFullName,
    visibility: snapshot.visibility,
    defaultBranch: snapshot.defaultBranch,
    commitSha: snapshot.commitSha,
    provenance: provenance(snapshot, status, false),
  };
}

/** Resolve one authenticated, immutable owner `.github` snapshot with LKG fallback. */
export async function resolveOwnerGithubConfig(
  store: OwnerConfigStore,
  input: {
    token: string;
    orgId: number;
    githubOwnerId: number;
    installationId: number;
    owner: string;
    requiredSlots?: readonly ConfigSlot[];
  },
): Promise<OwnerConfigResolution> {
  const sourceFullName = `${input.owner}/.github`;
  const paths = requiredPaths(input.requiredSlots ?? SHARED_PATHS.map(([slot]) => slot));
  const snapshot = await store.loadSnapshot(input.orgId);
  const installed = await store.findInstalledRepository(input.installationId, sourceFullName);
  if (!installed) {
    if (snapshot) await store.deleteSnapshot(input.orgId);
    return {
      config: null,
      files: [],
      status: "inaccessible",
      stale: false,
      sourceRepositoryId: null,
      sourceGithubRepoId: null,
      sourceFullName,
      visibility: null,
      defaultBranch: null,
      commitSha: null,
      provenance: SHARED_PATHS.map(([slot]) => ({
        slot: slot as ConfigSlot,
        source: "shared",
        path: null,
        repository: sourceFullName,
        stale: false,
        status: "inaccessible",
      })),
    };
  }

  let metadata: RepositoryMetadata;
  try {
    metadata = await fetchMetadata(input.token, installed.fullName);
    if (
      metadata.id !== installed.githubRepoId ||
      metadata.owner.id !== input.githubOwnerId ||
      metadata.full_name.toLowerCase() !== sourceFullName.toLowerCase() ||
      metadata.fork ||
      metadata.archived
    ) {
      throw new GithubConfigError("inaccessible", "Shared config repository identity is invalid");
    }
  } catch (error) {
    const status = error instanceof GithubConfigError ? error.status : "transient";
    if (
      status === "transient" &&
      snapshot?.sourceGithubRepoId === installed.githubRepoId &&
      snapshotHasRequiredContent(snapshot, paths)
    ) {
      await store.markDegraded(input.orgId, status);
      return fromSnapshot(snapshot, status);
    }
    if (snapshot) await store.deleteSnapshot(input.orgId);
    return unavailableResolution(sourceFullName, installed, status);
  }

  try {
    const commitSha = await fetchCommitSha(
      input.token,
      metadata.full_name,
      metadata.default_branch,
    );
    if (
      snapshot?.sourceGithubRepoId === installed.githubRepoId &&
      snapshot.commitSha === commitSha
    ) {
      const currentSnapshot: Snapshot = {
        ...snapshot,
        sourceRepositoryId: installed.id,
        sourceFullName: metadata.full_name,
        visibility: metadata.visibility,
        defaultBranch: metadata.default_branch,
      };
      if (snapshotHasRequiredContent(currentSnapshot, paths)) {
        return freshResolution(currentSnapshot);
      }
      for (const [, path, property] of SHARED_PATHS) {
        if (
          paths.includes(path) &&
          currentSnapshot.files.includes(path) &&
          !currentSnapshot.loadedFiles.includes(path)
        ) {
          currentSnapshot[property] = await fetchFileAtCommit(
            input.token,
            metadata.full_name,
            path,
            commitSha,
          );
          currentSnapshot.loadedFiles.push(path);
        }
      }
      await store.saveSnapshot(currentSnapshot);
      return freshResolution(currentSnapshot);
    }
    const config: OrgReviewConfig = {
      configYaml: null,
      guardrailsMd: null,
      contentPolicyMd: null,
    };
    const files: string[] = [];
    const discoveredPaths = await discoverSharedPaths(
      input.token,
      metadata.full_name,
      commitSha,
    );
    const loadedFiles: string[] = [];
    for (const [, path, property] of SHARED_PATHS) {
      const body = discoveredPaths.has(path) && paths.includes(path)
        ? await fetchFileAtCommit(input.token, metadata.full_name, path, commitSha)
        : null;
      config[property] = body;
      if (discoveredPaths.has(path)) files.push(path);
      if (body !== null) loadedFiles.push(path);
    }
    const saved: Snapshot = {
      orgId: input.orgId,
      sourceRepositoryId: installed.id,
      sourceGithubRepoId: installed.githubRepoId,
      sourceFullName: metadata.full_name,
      visibility: metadata.visibility,
      defaultBranch: metadata.default_branch,
      commitSha,
      ...config,
      files,
      loadedFiles,
    };
    await store.saveSnapshot(saved);
    return freshResolution(saved);
  } catch (error) {
    const status = error instanceof GithubConfigError ? error.status : "transient";
    if (
      status === "transient" &&
      snapshot?.sourceGithubRepoId === installed.githubRepoId &&
      snapshotHasRequiredContent(snapshot, paths)
    ) {
      await store.markDegraded(input.orgId, status);
      return fromSnapshot(snapshot, status);
    }
    if (snapshot) await store.deleteSnapshot(input.orgId);
    return unavailableResolution(sourceFullName, installed, status);
  }
}

function unavailableResolution(
  sourceFullName: string,
  installed: { id: number; githubRepoId: number },
  status: "inaccessible" | "transient",
): OwnerConfigResolution {
  return {
    config: null,
    files: [],
    status,
    stale: false,
    sourceRepositoryId: installed.id,
    sourceGithubRepoId: installed.githubRepoId,
    sourceFullName,
    visibility: null,
    defaultBranch: null,
    commitSha: null,
    provenance: SHARED_PATHS.map(([slot]) => ({
      slot: slot as ConfigSlot,
      source: "shared",
      path: null,
      repositoryId: installed.githubRepoId,
      repository: sourceFullName,
      stale: false,
      status,
    })),
  };
}
